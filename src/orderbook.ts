import { ERROR, CustomError } from './errors'
import { Order, OrderType, OrderUpdate, TimeInForce } from './order'
import { OrderQueue } from './orderqueue'
import { OrderSide } from './orderside'
import { Side } from './side'

interface ProcessOrder {
  done: Order[]
  partial: Order | null
  partialQuantityProcessed: number
  quantityLeft: number
  err: Error | null
}

const validTimeInForce = Object.values(TimeInForce)

export class OrderBook {
  private orders: { [key: string]: Order } = {}
  private bids: OrderSide
  private asks: OrderSide
  constructor() {
    this.bids = new OrderSide()
    this.asks = new OrderSide()
  }

  /**
   *  Add an order to the order book
   *
   *  @param {OrderType} type
   *         REQUIRED. A string literal type of order that can be `limit` or `market`
   *  @param {Side} side
   *         REQUIRED. A string literal for the direction of your order `sell` or `buy`
   *  @param {number} size
   *         REQUIRED. How much you want to sell or buy
   *  @param {number} [price]
   *         OPTIONAL. The price at which the order is to be fulfilled (only for limit order)
   *  @param {string} [orderID]
   *         OPTIONAL. Unique order ID in depth (only for limit order)
   *  @param {string} [timeInForce]
   *         OPTIONAL. Time-in-force type (GTK, FOK, IOC)
   *  @returns {ProcessOrder}
   *           An object with the result of the process or an error
   */
  createOrder = (
    // Common for all order types
    type: OrderType,
    side: Side,
    size: number,
    // Specific for limit order type
    price?: number,
    orderID?: string,
    timeInForce: TimeInForce = TimeInForce.GTC
  ): ProcessOrder => {
    switch (type) {
      case OrderType.MARKET:
        return this.market(side, size)
      case OrderType.LIMIT:
        return this.limit(
          side,
          orderID as string,
          size,
          price as number,
          timeInForce
        )
      default:
        return { err: CustomError(ERROR.ErrInvalidOrderType) } as ProcessOrder
    }
  }

  // Places new market order and gets definite quantity from the order book with market price
  // Arguments:
  //      side     - what do you want to do (ob.Sell or ob.Buy)
  //      quantity - how much quantity you want to sell or buy
  //      * to create new decimal number you should use decimal.New() func
  //        read more at https://github.com/shopspring/decimal
  // Return:
  //      error        - not nil if price is less or equal 0
  //      done         - not nil if your market order produces ends of another orders, this order will add to
  //                     the "done" slice
  //      partial      - not nil if your order has done but top order is not fully done
  //      partialQuantityProcessed - if partial is not nil, property contains processed quantity from partial order
  //      quantityLeft - more than zero if it is not enough orders to process all quantity
  market = (side: Side, size: number): ProcessOrder => {
    const response: ProcessOrder = {
      done: [],
      partial: null,
      partialQuantityProcessed: 0,
      quantityLeft: size,
      err: null,
    }

    if (side !== Side.SELL && side !== Side.BUY) {
      response.err = CustomError(ERROR.ErrInvalidSide)
      return response
    }

    if (!size || typeof size !== 'number' || size <= 0) {
      response.err = CustomError(ERROR.ErrInsufficientQuantity)
      return response
    }

    let iter
    let sideToProcess: OrderSide
    if (side === Side.BUY) {
      iter = this.asks.minPriceQueue
      sideToProcess = this.asks
    } else {
      iter = this.bids.maxPriceQueue
      sideToProcess = this.bids
    }

    while (size > 0 && sideToProcess.len() > 0) {
      // if sideToProcess.len > 0 it is not necessary to verify that bestPrice exists
      const bestPrice = iter()
      const { done, partial, partialQuantityProcessed, quantityLeft } =
        this.processQueue(bestPrice as OrderQueue, size)
      response.done = response.done.concat(done)
      response.partial = partial
      response.partialQuantityProcessed = partialQuantityProcessed
      size = quantityLeft || 0
    }
    response.quantityLeft = size
    return response
  }

  // Places new limit order to the OrderBook
  // Arguments:
  //      side     - what do you want to do (ob.Sell or ob.Buy)
  //      orderID  - unique order ID in depth
  //      quantity - how much quantity you want to sell or buy
  //      price    - no more expensive (or cheaper) this price
  //      timeInForce - specify how long the order will remain active or open before it is executed or expires
  //      * to create new decimal number you should use decimal.New() func
  //        read more at https://github.com/shopspring/decimal
  // Return:
  //      error   - not nil if quantity (or price) is less or equal 0. Or if order with given ID is exists
  //      done    - not nil if your order produces ends of another order, this order will add to
  //                the "done" slice. If your order have done too, it will be places to this array too
  //      partial - not nil if your order has done but top order is not fully done. Or if your order is
  //                partial done and placed to the orderbook without full quantity - partial will contain
  //                your order with remaining quantity
  //      partialQuantityProcessed - if partial order isn't nil, property contains processed quantity from partial order
  limit = (
    side: Side,
    orderID: string,
    size: number,
    price: number,
    timeInForce: TimeInForce = TimeInForce.GTC
  ): ProcessOrder => {
    const response: ProcessOrder = {
      done: [],
      partial: null,
      partialQuantityProcessed: 0,
      quantityLeft: size,
      err: null,
    }

    if (side !== Side.SELL && side !== Side.BUY) {
      response.err = CustomError(ERROR.ErrInvalidSide)
      return response
    }

    if (this.orders[orderID]) {
      response.err = CustomError(ERROR.ErrOrderExists)
      return response
    }

    if (!size || typeof size !== 'number' || size <= 0) {
      response.err = CustomError(ERROR.ErrInvalidQuantity)
      return response
    }

    if (!price || typeof price !== 'number' || price <= 0) {
      response.err = CustomError(ERROR.ErrInvalidPrice)
      return response
    }

    if (!validTimeInForce.includes(timeInForce)) {
      response.err = CustomError(ERROR.ErrInvalidTimeInForce)
      return response
    }

    let quantityToTrade = size
    let sideToProcess: OrderSide
    let sideToAdd: OrderSide
    let comparator
    let iter

    if (side === Side.BUY) {
      sideToAdd = this.bids
      sideToProcess = this.asks
      comparator = this.greaterThanOrEqual
      iter = this.asks.minPriceQueue
    } else {
      sideToAdd = this.asks
      sideToProcess = this.bids
      comparator = this.lowerThanOrEqual
      iter = this.bids.maxPriceQueue
    }

    if (timeInForce === TimeInForce.FOK) {
      const fillable = this.canFillOrder(sideToProcess, side, size, price)
      if (!fillable) {
        response.err = CustomError(ERROR.ErrLimitFOKNotFillable)
        return response
      }
    }

    let bestPrice = iter()
    while (
      quantityToTrade > 0 &&
      sideToProcess.len() > 0 &&
      bestPrice &&
      comparator(price, bestPrice.price())
    ) {
      const { done, partial, partialQuantityProcessed, quantityLeft } =
        this.processQueue(bestPrice, quantityToTrade)
      response.done = response.done.concat(done)
      response.partial = partial
      response.partialQuantityProcessed = partialQuantityProcessed
      quantityToTrade = quantityLeft || 0
      response.quantityLeft = quantityToTrade
      bestPrice = iter()
    }

    if (quantityToTrade > 0) {
      const order = new Order(orderID, side, quantityToTrade, price, Date.now())
      if (response.done.length > 0) {
        response.partialQuantityProcessed = size - quantityToTrade
        response.partial = order
      }
      this.orders[orderID] = sideToAdd.append(order)
    } else {
      let totalQuantity = 0
      let totalPrice = 0

      response.done.forEach((order: Order) => {
        totalQuantity += order.size
        totalPrice += order.price * order.size
      })
      if (response.partialQuantityProcessed && response.partial) {
        if (response.partialQuantityProcessed > 0) {
          totalQuantity += response.partialQuantityProcessed
          totalPrice +=
            response.partial.price * response.partialQuantityProcessed
        }
      }

      response.done.push(
        new Order(orderID, side, size, totalPrice / totalQuantity, Date.now())
      )
    }

    // If IOC order was not matched completely remove from the order book
    if (timeInForce === TimeInForce.IOC && response.quantityLeft > 0) {
      this.cancel(orderID)
    }

    return response
  }

  greaterThanOrEqual = (a: number, b: number): boolean => {
    return a >= b
  }

  lowerThanOrEqual = (a: number, b: number): boolean => {
    return a <= b
  }

  processQueue = (orderQueue: OrderQueue, quantityToTrade: number) => {
    const response: ProcessOrder = {
      done: [],
      partial: null,
      partialQuantityProcessed: 0,
      quantityLeft: quantityToTrade,
      err: null,
    }
    if (response.quantityLeft) {
      while (orderQueue.len() > 0 && response.quantityLeft > 0) {
        const headOrder = orderQueue.head()
        if (headOrder) {
          if (response.quantityLeft < headOrder.size) {
            response.partial = new Order(
              headOrder.id,
              headOrder.side,
              headOrder.size - response.quantityLeft,
              headOrder.price,
              headOrder.time
            )
            this.orders[headOrder.id] = response.partial
            response.partialQuantityProcessed = response.quantityLeft
            orderQueue.update(headOrder, response.partial)
            response.quantityLeft = 0
          } else {
            response.quantityLeft = response.quantityLeft - headOrder.size
            const canceledOrder = this.cancel(headOrder.id)
            if (canceledOrder) response.done.push(canceledOrder)
          }
        }
      }
    }
    return response
  }

  // Returns order by id
  order = (orderID: string): Order | undefined => {
    return this.orders[orderID]
  }

  // Returns price levels and volume at price level
  depth = () => {
    let level = this.asks.maxPriceQueue()
    const asks = []
    const bids = []
    while (level) {
      const levelPrice = level.price()
      asks.push([levelPrice, level.volume()])
      level = this.asks.lowerThan(levelPrice)
    }

    level = this.bids.maxPriceQueue()
    while (level) {
      const levelPrice = level.price()
      bids.push([levelPrice, level.volume()])
      level = this.bids.lowerThan(levelPrice)
    }
    return [asks, bids]
  }

  // Modify an existing order with given ID
  modify = (
    orderID: string,
    orderUpdate: OrderUpdate
  ): Order | undefined | void => {
    const order = this.orders[orderID]
    if (!order) return
    const side = orderUpdate.side
    if (side === Side.BUY) {
      return this.bids.update(order, orderUpdate)
    } else if (side === Side.SELL) {
      return this.asks.update(order, orderUpdate)
    } else {
      throw CustomError(ERROR.ErrInvalidSide)
    }
  }

  // Removes order with given ID from the order book
  cancel = (orderID: string): Order | undefined => {
    const order = this.orders[orderID]
    if (!order) return
    delete this.orders[orderID]
    if (order.side === Side.BUY) {
      return this.bids.remove(order)
    }
    return this.asks.remove(order)
  }

  canFillOrder = (
    orderSide: OrderSide,
    side: Side,
    size: number,
    price: number
  ) => {
    return side === Side.BUY
      ? this.buyOrderCanBeFilled(orderSide, size, price)
      : this.sellOrderCanBeFilled(orderSide, size, price)
  }

  buyOrderCanBeFilled(orderSide: OrderSide, size: number, price: number) {
    let cumulativeSize = 0
    orderSide.priceTree().forEach((_key, priceLevel) => {
      if (price >= priceLevel.price() && cumulativeSize < size) {
        cumulativeSize += priceLevel.volume()
      } else {
        return true // break the loop
      }
    })
    return cumulativeSize >= size
  }

  sellOrderCanBeFilled(orderSide: OrderSide, size: number, price: number) {
    let cumulativeSize = 0
    orderSide.priceTree().forEach((_key, priceLevel) => {
      if (price <= priceLevel.price() && cumulativeSize < size) {
        cumulativeSize += priceLevel.volume()
      } else {
        return true // break the loop
      }
    })
    return cumulativeSize >= size
  }

  // Returns total market price for requested quantity
  // if err is not nil price returns total price of all levels in side
  calculateMarketPrice = (
    side: Side,
    size: number
  ): {
    price: number
    err: null | Error
  } => {
    let price = 0
    let err = null
    let level: OrderQueue | undefined
    let iter: (price: number) => OrderQueue | undefined

    if (side === Side.BUY) {
      level = this.asks.minPriceQueue()
      iter = this.asks.greaterThan
    } else {
      level = this.bids.maxPriceQueue()
      iter = this.bids.lowerThan
    }

    while (size > 0 && level) {
      const levelVolume = level.volume()
      const levelPrice = level.price()
      if (this.greaterThanOrEqual(size, levelVolume)) {
        price += levelPrice * levelVolume
        size -= levelVolume
        level = iter(levelPrice)
      } else {
        price += levelPrice * size
        size = 0
      }
    }

    if (size > 0) {
      err = CustomError(ERROR.ErrInsufficientQuantity)
    }

    return { price, err }
  }

  toString(): string {
    return (
      this.asks.toString() +
      '\r\n------------------------------------' +
      this.bids.toString()
    )
  }
}
