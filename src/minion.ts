import { getLayoutVersion, Market } from '@safely-project/serum'
import { Connection, PublicKey } from '@safecoin/web3.js'
import { App, HttpResponse, DISABLED, SSLApp, TemplatedApp, us_listen_socket_close, WebSocket } from 'uWebSockets.js'
import { isMainThread, threadId, workerData } from 'worker_threads'
import { CHANNELS, MESSAGE_TYPES_PER_CHANNEL, OPS } from './consts'
import {
  cleanupChannel,
  executeAndRetry,
  getAllowedValuesText,
  getDidYouMean,
  minionReadyChannel,
  serumDataChannel,
  serumMarketsChannel,
  wait
} from './helpers'
import { logger } from './logger'
import { MessageEnvelope } from './serum_producer'
import { ErrorResponse, RecentTrades, SerumListMarketItem, SerumMarket, SubRequest, SuccessResponse } from './types'

const meta = {
  minionId: threadId
}

if (isMainThread) {
  const message = 'Exiting. Worker is not meant to run in main thread'
  logger.log('error', message, meta)

  throw new Error(message)
}

process.on('unhandledRejection', (err) => {
  throw err
})

// based on https://github.com/uNetworking/uWebSockets.js/issues/335#issuecomment-643500581
const RateLimit = (limit: number, interval: number) => {
  let now = 0
  const last = Symbol(),
    count = Symbol()
  setInterval(() => ++now, interval)
  return (ws: any) => {
    if (ws[last] != now) {
      ws[last] = now
      ws[count] = 1

      return false
    } else {
      return ++ws[count] > limit
    }
  }
}

// Minion is the actual HTTP and WS server implementation
// it is meant to run in Node.js worker_thread and handles:
// - HTTP requests
// - WS subscriptions requests
// - WS data publishing to connected clients

class Minion {
  private readonly _server: TemplatedApp
  private _apiVersion = '1'
  private readonly MAX_MESSAGES_PER_SECOND = 50

  // 100 messages per second limit
  private readonly _wsMessagesRateLimit: (ws: any) => boolean = RateLimit(this.MAX_MESSAGES_PER_SECOND, 1000)

  private readonly _l2SnapshotsSerialized: { [market: string]: string } = {}
  private readonly _l3SnapshotsSerialized: { [market: string]: string } = {}
  private readonly _recentTradesSerialized: { [market: string]: string } = {}
  private readonly _quotesSerialized: { [market: string]: string } = {}
  private readonly _marketNames: string[]
  private _listenSocket: any | undefined = undefined
  private _openConnectionsCount = 0
  private _tid: NodeJS.Timeout | undefined = undefined

  private MAX_BACKPRESSURE = 3 * 1024 * 1024
  constructor(private readonly _nodeEndpoint: string, private readonly _markets: SerumMarket[]) {
    this._marketNames = _markets.map((m) => m.name)
    this._server = this._initServer()

    this._tid = setInterval(() => {
      logger.log('debug', `Open WS client connections count: ${this._openConnectionsCount}`, meta)
    }, 60 * 1000)
  }

  private _initServer() {
    const apiPrefix = `/v${this._apiVersion}`
    const useSSL = process.env.KEY_FILE_NAME !== undefined
    const WsApp = useSSL ? SSLApp : App

    const options = useSSL
      ? {
          key_file_name: process.env.KEY_FILE_NAME,
          cert_file_name: process.env.CERT_FILE_NAME
        }
      : {}
    return WsApp(options)
      .ws(`${apiPrefix}/ws`, {
        compression: DISABLED,
        maxPayloadLength: 256 * 1024,
        idleTimeout: 60, // closes WS connection if no message/ping send/received in 1 minute
        maxBackpressure: this.MAX_BACKPRESSURE, // close if client is too slow to read the data fast enough
        closeOnBackpressureLimit: true,
        message: (ws: any, message: any) => {
          this._handleSubscriptionRequest(ws, message)
        },
        open: () => {
          this._openConnectionsCount++
        },
        close: () => {
          this._openConnectionsCount--
        }
      } as any)

      .get(`${apiPrefix}/markets`, this._listMarkets)
  }

  public async start(port: number) {
    return new Promise<void>((resolve, reject) => {
      this._server.listen(port, (socket) => {
        if (socket) {
          this._listenSocket = socket
          logger.log('info', `Listening on port ${port}`, meta)
          resolve()
        } else {
          const message = `Failed to listen on port ${port}`
          logger.log('error', message, meta)
          reject(new Error(message))
        }
      })
    })
  }

  public async stop() {
    if (this._listenSocket !== undefined) {
      us_listen_socket_close(this._listenSocket)
    }

    if (this._tid !== undefined) {
      clearInterval(this._tid)
    }
  }

  private _cachedListMarketsResponse: string | undefined = undefined

  //async based on https://github.com/uNetworking/uWebSockets.js/blob/master/examples/AsyncFunction.js
  private _listMarkets = async (res: HttpResponse) => {
    res.onAborted(() => {
      res.aborted = true
    })

    if (this._cachedListMarketsResponse === undefined) {
      const markets = await Promise.all(
        this._markets.map((market) => {
          return executeAndRetry(
            async () => {
              const connection = new Connection(this._nodeEndpoint)
              const { tickSize, minOrderSize, baseMintAddress, quoteMintAddress, programId } = await Market.load(
                connection,
                new PublicKey(market.address),
                undefined,
                new PublicKey(market.programId)
              )

              const [baseCurrency, quoteCurrency] = market.name.split('/')
              const serumMarket: SerumListMarketItem = {
                name: market.name,
                baseCurrency: baseCurrency!,
                quoteCurrency: quoteCurrency!,
                version: getLayoutVersion(programId),
                address: market.address,
                programId: market.programId,
                baseMintAddress: baseMintAddress.toBase58(),
                quoteMintAddress: quoteMintAddress.toBase58(),
                tickSize,
                minOrderSize,
                deprecated: market.deprecated
              }
              return serumMarket
            },
            { maxRetries: 10 }
          )
        })
      )

      this._cachedListMarketsResponse = JSON.stringify(markets, null, 2)
      serumMarketsChannel.postMessage(this._cachedListMarketsResponse)
    }

    await wait(1)

    if (!res.aborted) {
      res.writeStatus('200 OK')
      res.writeHeader('Content-Type', 'application/json')
      res.end(this._cachedListMarketsResponse)
    }
  }

  public initMarketsCache(cachedResponse: string) {
    this._cachedListMarketsResponse = cachedResponse
    logger.log('info', 'Cached markets info response', meta)
  }

  public processMessages(messages: MessageEnvelope[]) {
    for (const message of messages) {
      const topic = `${message.type}-${message.market}`

      if (logger.level === 'debug') {
        const diff = new Date().valueOf() - new Date(message.timestamp).valueOf()
        logger.log('debug', `Processing message, topic: ${topic}, receive delay: ${diff}ms`, meta)
      }
      if (message.type === 'l2snapshot') {
        this._l2SnapshotsSerialized[message.market] = message.payload
      }
      if (message.type === 'l3snapshot') {
        this._l3SnapshotsSerialized[message.market] = message.payload
      }

      if (message.type === 'quote') {
        this._quotesSerialized[message.market] = message.payload
      }

      if (message.type === 'recent_trades') {
        this._recentTradesSerialized[message.market] = message.payload
      }

      if (message.publish) {
        this._server.publish(topic, message.payload)
      }
    }
  }

  private async _handleSubscriptionRequest(ws: WebSocket, buffer: ArrayBuffer) {
    try {
      if (this._wsMessagesRateLimit(ws)) {
        const message = `Too many requests, slow down. Current limit: ${this.MAX_MESSAGES_PER_SECOND} messages per second.`
        logger.log('info', message, meta)

        const errorMessage: ErrorResponse = {
          type: 'error',
          message,
          timestamp: new Date().toISOString()
        }

        await this._send(ws, () => JSON.stringify(errorMessage))

        return
      }

      const message = Buffer.from(buffer).toString()

      if (message === 'ping' || message === 'PING') {
        return
      }

      const validationResult = this._validateRequestPayload(message)

      if (validationResult.isValid === false) {
        logger.log('debug', `Invalid subscription message received, error: ${validationResult.error}`, {
          message,
          ...meta
        })

        const errorMessage: ErrorResponse = {
          type: 'error',
          message: validationResult.error,
          timestamp: new Date().toISOString()
        }

        await this._send(ws, () => JSON.stringify(errorMessage))

        return
      }

      const request = validationResult.request

      // 'unpack' channel to specific message types that will be published for it
      const requestedTypes = MESSAGE_TYPES_PER_CHANNEL[request.channel]
      for (const market of request.markets) {
        for (const type of requestedTypes) {
          const topic = `${type}-${market}`
          if (request.op === 'subscribe') {
            if (ws.isSubscribed(topic)) {
              continue
            }

            if (type === 'recent_trades') {
              const recentTrades = this._recentTradesSerialized[market]
              if (recentTrades !== undefined) {
                await this._send(ws, () => this._recentTradesSerialized[market])
              } else {
                const emptyRecentTradesMessage: RecentTrades = {
                  type: 'recent_trades',
                  market,
                  timestamp: new Date().toISOString(),
                  trades: []
                }

                await this._send(ws, () => JSON.stringify(emptyRecentTradesMessage))
              }
            }

            if (type === 'quote') {
              await this._send(ws, () => this._quotesSerialized[market])
            }

            if (type == 'l2snapshot') {
              await this._send(ws, () => this._l2SnapshotsSerialized[market])
            }

            if (type === 'l3snapshot') {
              await this._send(ws, () => this._l3SnapshotsSerialized[market])
            }

            const succeeded = ws.subscribe(topic)
            if (!succeeded) {
              logger.log('info', `Subscribe failure`, {
                topic,
                bufferedAmount: ws.getBufferedAmount()
              })
            }
          } else {
            if (ws.isSubscribed(topic)) {
              ws.unsubscribe(topic)
            }
          }
        }
      }
      const confirmationMessage: SuccessResponse = {
        type: request.op == 'subscribe' ? 'subscribed' : 'unsubscribed',
        channel: request.channel,
        markets: request.markets,
        timestamp: new Date().toISOString()
      }

      await this._send(ws, () => JSON.stringify(confirmationMessage))

      logger.log('debug', request.op == 'subscribe' ? 'Subscribe successfully' : 'Unsubscribed successfully', {
        successMessage: confirmationMessage,
        ...meta
      })
    } catch (err: any) {
      const message = 'Subscription request internal error'
      const errorMessage = typeof err === 'string' ? err : `${err.message}, ${err.stack}`

      logger.log('info', `${message}, ${errorMessage}`, meta)
      try {
        ws.end(1011, message)
      } catch {}
    }
  }

  private async _send(ws: WebSocket, getMessage: () => string | undefined) {
    let retries = 0
    while (ws.getBufferedAmount() > this.MAX_BACKPRESSURE / 2) {
      await wait(10)
      retries += 1

      if (retries > 200) {
        ws.end(1008, 'Too much backpressure')
        return
      }
    }

    const message = getMessage()
    if (message !== undefined) {
      ws.send(message)
    }
  }

  private _validateRequestPayload(message: string) {
    let payload
    try {
      payload = JSON.parse(message) as SubRequest
    } catch {
      return {
        isValid: false,
        error: `Invalid JSON`
      } as const
    }

    if (OPS.includes(payload.op) === false) {
      return {
        isValid: false,
        error: `Invalid op: '${payload.op}'.${getDidYouMean(payload.op, OPS)} ${getAllowedValuesText(OPS)}`
      } as const
    }

    if (CHANNELS.includes(payload.channel) === false) {
      return {
        isValid: false,
        error: `Invalid channel provided: '${payload.channel}'.${getDidYouMean(
          payload.channel,
          CHANNELS
        )}  ${getAllowedValuesText(CHANNELS)}`
      } as const
    }

    if (!Array.isArray(payload.markets) || payload.markets.length === 0) {
      return {
        isValid: false,
        error: `Invalid or empty markets array provided.`
      } as const
    }

    if (payload.markets.length > 100) {
      return {
        isValid: false,
        error: `Too large markets array provided (> 100 items).`
      } as const
    }

    for (const market of payload.markets) {
      if (this._marketNames.includes(market) === false) {
        return {
          isValid: false,
          error: `Invalid market name provided: '${market}'.${getDidYouMean(
            market,
            this._marketNames
          )} ${getAllowedValuesText(this._marketNames)}`
        } as const
      }
    }

    return {
      isValid: true,
      error: undefined,
      request: payload
    } as const
  }
}

const { port, nodeEndpoint, markets, minionNumber } = workerData as {
  port: number
  nodeEndpoint: string
  markets: SerumMarket[]
  minionNumber: number
}

const minion = new Minion(nodeEndpoint, markets)

let lastPublishTimestamp = new Date()

if (minionNumber === 0) {
  setInterval(() => {
    const noDataPublishedForSeconds = (new Date().valueOf() - lastPublishTimestamp.valueOf()) / 1000
    if (noDataPublishedForSeconds > 30) {
      logger.log('info', `No market data published for prolonged time`, {
        lastPublishTimestamp: lastPublishTimestamp.toISOString(),
        noDataPublishedForSeconds
      })
    }
  }, 15 * 1000).unref()
}

minion.start(port).then(() => {
  serumDataChannel.onmessage = (message) => {
    lastPublishTimestamp = new Date()

    minion.processMessages(message.data)
  }

  serumMarketsChannel.onmessage = (message) => {
    minion.initMarketsCache(message.data)
  }

  minionReadyChannel.postMessage('ready')
})

cleanupChannel.onmessage = async () => {
  await minion.stop()
}
