import { Market } from '@safely-project/serum'
import { PublicKey } from '@safecoin/web3.js'
import { isMainThread, workerData } from 'worker_threads'
import { MessageType } from './consts'
import { DataMapper } from './data_mapper'
import { decimalPlaces, serumDataChannel, serumProducerReadyChannel } from './helpers'
import { logger } from './logger'
import { RPCClient } from './rpc_client'
import { SerumMarket } from './types'

if (isMainThread) {
  const message = 'Exiting. Worker is not meant to run in main thread'
  logger.log('error', message)

  throw new Error(message)
}

process.on('unhandledRejection', (err) => {
  throw err
})

// SerumProducer responsibility is to:
// - connect to Serum Node RPC API via WS and subscribe to single Serum market
// - map received data to normalized data messages and broadcast those

export class SerumProducer {
  constructor(
    private readonly _options: {
      nodeEndpoint: string
      wsEndpointPort: number | undefined
      market: SerumMarket
      commitment: string
    }
  ) {}

  public async run(onData: OnDataCallback) {
    let started = false
    logger.log('info', `Serum producer starting for ${this._options.market.name} market...`)

    // don't use Solana web3.js Connection but custom rpcClient so we have more control and insight what is going on
    const rpcClient = new RPCClient({
      nodeEndpoint: this._options.nodeEndpoint,
      commitment: this._options.commitment,
      wsEndpointPort: this._options.wsEndpointPort
    })

    const market = await Market.load(
      rpcClient as any,
      new PublicKey(this._options.market.address),
      undefined,
      new PublicKey(this._options.market.programId)
    )

    const priceDecimalPlaces = decimalPlaces(market.tickSize)
    const sizeDecimalPlaces = decimalPlaces(market.minOrderSize)

    const dataMapper = new DataMapper({
      symbol: this._options.market.name,
      market,
      priceDecimalPlaces,
      sizeDecimalPlaces
    })

    let start = process.hrtime()
    const interval = 600

    // based on https://github.com/tj/node-blocked/blob/master/index.js
    setInterval(() => {
      const delta = process.hrtime(start)
      const nanosec = delta[0] * 1e9 + delta[1]
      const ms = nanosec / 1e6
      const n = ms - interval

      if (n > 200) {
        logger.log('info', `Event loop blocked for ${Math.round(n)} ms.`, {
          market: this._options.market.name
        })
      }

      start = process.hrtime()
    }, interval).unref()

    for await (const notification of rpcClient.streamAccountsNotification(market, this._options.market.name)) {
      if (started === false) {
        logger.log('info', `Serum producer started for ${this._options.market.name} market...`)
        started = true
        serumProducerReadyChannel.postMessage('ready')
      }

      const messagesForSlot = [...dataMapper.map(notification)]

      if (messagesForSlot.length > 0) {
        onData(messagesForSlot)
      }
    }
  }
}

const serumProducer = new SerumProducer(workerData)

serumProducer.run((envelopes) => {
  serumDataChannel.postMessage(envelopes)
})

export type MessageEnvelope = {
  type: MessageType
  market: string
  publish: boolean
  payload: string
  timestamp: string
}

type OnDataCallback = (envelopes: MessageEnvelope[]) => void
