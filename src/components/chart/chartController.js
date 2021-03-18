import '../../data/typedef'
import store from '../../store'
import seriesData from '../../data/series'
import { cache, saveChunk, clearCache, cacheRange } from './chartCache'
import { formatAmount, formatTime, getHms, setValueByDotNotation, slugify } from '../../utils/helpers'
import { defaultChartOptions, defaultPlotsOptions } from './chartOptions'
import * as _serieFunctions from './serieFunctions'

import * as TV from 'lightweight-charts'
import dialogService from '../../services/dialog'
import { formatRgb, toRgb } from 'color-fns'
import { MAX_BARS_PER_CHUNKS } from '../../utils/constants'
const serieFunctions = Object.keys(_serieFunctions).reduce((o, name) => {
  o[name] = _serieFunctions[name]
  return o
}, {})

const availableSerieFunctions = Object.keys(serieFunctions).reduce((obj, name) => {
  obj[name] = {
    needsMemory: ['cma', 'sma', 'ema'].indexOf(name) !== -1
  }

  return obj
}, {})

const noRedrawOptions = [/priceFormat/i, /color/i, /width/i, 'priceLineStyle', 'lastValueVisible', 'priceLineVisible', 'borderVisible']

export default class ChartController {
  constructor() {
    /** @type {TV.IChartApi} */
    this.chartInstance = null

    /**
     * @type {Element}
     */
    this.chartElement = null

    /**
     * @type ActiveSerie[]
     */
    this.activeSeries = []

    /**
     * @type Renderer
     */
    this.activeRenderer = null

    /**
     * @type Chunk
     */
    this.activeChunk = null

    /**
     * @type Range
     */
    this.renderedRange = { from: null, to: null }

    /**
     * @type Trade[]
     */
    this.queuedTrades = []
  }

  createChart(containerElement, chartDimensions) {
    console.log(`[chart/controller] create chart`)

    let chartColor

    if (store.state.settings.chartColor) {
      chartColor = store.state.settings.chartColor
    } else {
      chartColor = store.state.settings.chartTheme === 'light' ? '#111111' : '#f6f6f6'
    }

    const options = Object.assign({}, defaultChartOptions, chartDimensions)

    const chartColorOptions = this.getChartColorOptions(chartColor)

    for (let prop in chartColorOptions) {
      Object.assign(options[prop], chartColorOptions[prop])
    }

    if (store.state.settings.series.price && store.state.settings.series.price.scaleMargins) {
      options.priceScale.scaleMargins = store.state.settings.series.price.scaleMargins
    }

    this.chartInstance = TV.createChart(containerElement, options)
    this.chartElement = containerElement

    this.addEnabledSeries()
  }

  /**
   * remove series, destroy this.chartInstance and cancel related events1
   */
  removeChart() {
    console.log(`[chart/controller] remove chart`)

    if (!this.chartInstance) {
      return
    }

    while (this.activeSeries.length) {
      this.removeSerie(this.activeSeries[0])
    }

    this.chartInstance.remove()

    this.chartInstance = null
  }

  /**
   * Get active serie by id
   * @returns {ActiveSerie} serie
   */
  getSerie(id) {
    for (let i = 0; i < this.activeSeries.length; i++) {
      if (this.activeSeries[i].id === id) {
        return this.activeSeries[i]
      }
    }
  }

  /**
   * Update one serie's option
   * @param {Object} obj vuex store payload
   * @param {string} obj.id serie id
   * @param {string} obj.key option key
   * @param {any} obj.value serie id
   */
  setSerieOption({ id, key, value }) {
    const serie = this.getSerie(id)

    if (!serie) {
      return
    }

    let firstKey = key

    if (key.indexOf('.') !== -1) {
      const path = key.split('.')
      setValueByDotNotation(serie.options, path, value)
      firstKey = path[0]
    } else {
      serie.options[key] = value
    }

    serie.api.applyOptions({
      [firstKey]: serie.options[firstKey]
    })

    for (let i = 0; i < noRedrawOptions.length; i++) {
      if (noRedrawOptions[i] === firstKey || (noRedrawOptions[i] instanceof RegExp && noRedrawOptions[i].test(firstKey))) {
        return
      }
    }

    this.redrawSerie(id)
  }

  /**
   * Rebuild the whole serie
   * @param {string} id serie id
   */
  rebuildSerie(id) {
    this.removeSerie(this.getSerie(id))

    if (this.addSerie(id)) {
      this.redrawSerie(id)
    }
  }

  /**
   * Update chart main scale (priceScale) margins
   * @param {{top: number, bottom: number}} margins
   */
  setPriceMargins(margins) {
    this.chartInstance.applyOptions({
      priceScale: {
        scaleMargins: margins
      }
    })
  }

  /**
   * Redraw one specific serie (and the series it depends on)
   * @param {string} id
   */
  redrawSerie(id) {
    let bars = []

    for (let chunk of cache) {
      if (chunk.rendered) {
        bars = bars.concat(chunk.bars)
      }
    }

    const series = this.getSerieDependencies(this.getSerie(id))

    series.push(id)

    this.renderBars(bars, series)
  }

  /**
   * Redraw
   * @param
   */
  redraw() {
    this.renderVisibleChunks()
  }

  /**
   * Return a list of available function that can be used in series inputs
   * @returns {string[]} names of available functions
   */
  getAvailableSerieFunctions() {
    return Object.keys(availableSerieFunctions)
  }

  /**
   *
   * @param {ActiveSerie} serie
   */
  prepareSerie(serie) {
    let input = (serie.options.input || serie.input).toString().replace(/\n/g, '')

    // eslint-disable-next-line no-useless-escape
    const reg = new RegExp(`(${this.getAvailableSerieFunctions().join('|')})\\(([^\S]+)\\)`, 'g')

    const memory = []

    if (/\b(this)\b/i.test(input)) {
      memory.push({
        id: null
      })
    }

    let match

    do {
      if ((match = reg.exec(input))) {
        const args = match[2].split(',').map(a => a.trim())

        const id = slugify(match[2])

        if (availableSerieFunctions[match[1]].needsMemory) {
          memory.push({
            id,
            args,
            name: match[1],
            input: match[2]
          })

          args.unshift(`bar.series.${serie.id}.memory[${memory.length - 1}]`)
        }

        input = input.replace(match[0], `fn.${match[1]}.call(this, ${args.join(',')})`)
      }
    } while (match)

    serie.memory = memory

    try {
      serie.serieFunctionDefinition = this.buildSerieFunction(serie, input)
    } catch (error) {
      setTimeout(() => {
        store.dispatch('app/showNotice', {
          type: 'error',
          icon: 'icon-warning',
          title: `serie ${serie.id} contain an error<br>Error: ${error.message}`
        })
      })
      console.error(error)

      if (!dialogService.isDialogOpened('SerieDialog')) {
        dialogService.open('chart/SerieDialog', {
          id: serie.id
        })
      }

      return false
    }

    return serie
  }

  buildSerieFunction(serie, input) {
    const timestamp = Math.floor(+new Date() / 1000 / store.state.settings.timeframe) * store.state.settings.timeframe
    const bar = {
      timestamp: timestamp,
      exchanges: {},
      open: null,
      high: null,
      low: null,
      close: null,
      vbuy: 0,
      vsell: 0,
      cbuy: 0,
      csell: 0,
      lbuy: 0,
      lsell: 0,
      series: {
        [serie.id]: {
          value: 0,
          memoryThis: {}
        }
      }
    }

    const dependencies = this.getSerieDependencies(serie)
    dependencies.push(serie.id)

    for (let i = 0; i < dependencies.length; i++) {
      bar.series[dependencies[i]] = {
        value: 0
      }

      if (dependencies[i] === serie.id && serie.memory.length) {
        bar.series[serie.id].memory = serie.memory
      }
    }

    // test run
    const value = new Function('fn', 'bar', 'options', 'return ' + input.replace(/bar\.series\.[a-zA-Z0-9_]+\.point\.[a-z]+/g, 1)).apply(
      bar.series[serie.id].memoryThis,
      [serieFunctions, bar, serie.options]
    )

    const type = serie.options.type || serie.type

    if (value !== null && typeof value !== 'object') {
      input = `{ value: ${input} }`
    } else if (typeof value.open !== 'undefined' && type !== 'candlestick' && type !== 'bars') {
      input = `{ value: ${input}.close }`
    } else if (typeof value.open === 'undefined' && (type === 'candlestick' || type === 'bars')) {
      throw new Error('data is OHLC format but serie type is not')
    }

    return [null, 'fn', 'bar', 'options', 'return ' + input]
  }

  bindSerie(serie, renderer) {
    if (!renderer || typeof renderer.series[serie.id] !== 'undefined') {
      return
    }

    renderer.series[serie.id] = {
      value: null
    }

    if (serie.memory.length) {
      renderer.series[serie.id].memory = []
    }

    for (let i = 0; i < serie.memory.length; i++) {
      const fn = serie.memory[i]

      if (fn.id) {
        renderer.series[serie.id].memory.push({
          output: null,
          length: eval(fn.args[2].toString().replace(/^options/, 'serie.options')),
          points: [],
          count: 0,
          sum: 0
        })
      } else {
        renderer.series[serie.id].memoryThis = {}
      }
    }

    serie.adapter = (new (Function.prototype.bind.apply(Function, serie.serieFunctionDefinition))).bind(renderer.series[serie.id].memoryThis, serieFunctions) // prettier-ignore
  }

  /**
   * Detach serie from renderer
   * @param {ActiveSerie} serie
   * @param {Renderer} renderer
   */
  unbindSerie(serie, renderer) {
    if (!renderer || typeof renderer.series[serie.id] === 'undefined') {
      return
    }

    delete renderer.series[serie.id]
  }

  /**
   * Add all enabled series
   */
  addEnabledSeries() {
    for (let id in seriesData) {
      if (!store.state.settings.series[id] || store.state.settings.series[id].enabled === false) {
        continue
      }

      this.addSerie(id)
    }
  }

  /**
   * get series that depends on this serie
   * @param {ActiveSerie} serie
   * @returns {string[]} id of series
   */
  getSeriesDependendingOn(serie) {
    const series = []

    for (let i = 0; i < this.activeSeries.length; i++) {
      const serieCompare = this.activeSeries[i]

      if (serieCompare.id === serie.id) {
        continue
      }

      if (this.isSerieReferencedIn(serie, serieCompare)) {
        series.push(serieCompare.id)
      }
    }

    return series
  }

  /**
   * get dependencies of serie
   * @param {ActiveSerie} serie
   * @returns {string[]} id of series
   */
  getSerieDependencies(serie) {
    const functionString = serie.input.toString()
    const reg = new RegExp(`bar\\.series\\.([a-z0-9_]+)\\.`, 'g')

    const depencencies = []

    let match

    do {
      if ((match = reg.exec(functionString)) && match[1] !== serie.id) {
        depencencies.push(match[1])
      }
    } while (match)

    return depencencies
  }

  /**
   * is serieA referenced in serieB
   * @param {ActiveSerie} serieA
   * @param {ActiveSerie} serieB
   * @returns {boolean}
   */
  isSerieReferencedIn(serieA, serieB) {
    const functionString = serieB.input.toString()
    const reg = new RegExp(`bar\\.series\\.${serieA.id}\\.`, 'g')

    return !!functionString.match(reg)
  }
  /**
   * register serie and create serie api12
   * @param {string} serieId serie id
   * @returns {boolean} success if true
   */
  addSerie(id) {
    const serieData = seriesData[id]
    const serieOptions = Object.assign(
      {},
      defaultPlotsOptions[serieData.type] || {},
      seriesData[id].options || {},
      store.state.settings.series[id] || {}
    )
    const serieType = serieOptions.type || seriesData[id].type

    const apiMethodName = 'add' + (serieType.charAt(0).toUpperCase() + serieType.slice(1)) + 'Series'

    const serie = this.prepareSerie({
      id,
      type: serieType,
      input: serieData.input,
      options: serieOptions
    })

    if (!serie) {
      return false
    }

    serie.api = this.chartInstance[apiMethodName](serieOptions)

    this.activeSeries.push(serie)

    store.state.app.activeSeries.push(id)

    this.bindSerie(serie, this.activeRenderer)

    return true
  }

  /**
   * Derender serie
   * if there is series depending on this serie, they will be also removed
   * @param {ActiveSerie} serie
   */
  removeSerie(serie) {
    if (!serie) {
      return
    }

    // remove from chart instance (derender)
    this.chartInstance.removeSeries(serie.api)

    // unbind from activebar (remove serie meta data like sma memory etc)
    this.unbindSerie(serie, this.activeRenderer)

    // update store (runtime prop)
    store.state.app.activeSeries.splice(store.state.app.activeSeries.indexOf(serie.id), 1)
    store.state.app.activeSeries = store.state.app.activeSeries.slice(0, store.state.app.activeSeries.length)

    // recursive remove of dependent series
    for (let dependentId of this.getSeriesDependendingOn(serie)) {
      this.removeSerie(this.getSerie(dependentId))
    }

    // remove from active series model
    this.activeSeries.splice(this.activeSeries.indexOf(serie), 1)
  }

  /**
   * toggle serie on or off
   * if turn on it will try redraw serie
   * @param {Object} obj vuex store payload
   * @param {string} obj.id serie id
   * @param {boolean} obj.value true = enable serie, false = disable
   */
  toggleSerie({ id, value }) {
    if (!value) {
      this.removeSerie(this.getSerie(id))
    } else {
      if (this.addSerie(id)) {
        this.redrawSerie(id)
      }
    }
  }

  /**
   * get visible range (or optimal range if this.chartInstance has no range0)
   * @return {Range} range
   */
  getVisibleRange() {
    const visibleRange = this.getUTCVisibleRange()

    if (visibleRange) {
      const scrollPosition = this.chartInstance.timeScale().scrollPosition()
      if (scrollPosition > 0) {
        visibleRange.to =
          Math.floor((visibleRange.to + scrollPosition * store.state.settings.timeframe) / store.state.settings.timeframe) *
          store.state.settings.timeframe
      }

      return { from: visibleRange.from, to: visibleRange.to, median: visibleRange.from + (visibleRange.to - visibleRange.from) / 2 }
    } else {
      return this.getRealtimeRange()
    }
  }

  getUTCVisibleRange() {
    const visibleRange = this.chartInstance.timeScale().getVisibleRange()
    const offset = store.state.settings.timezoneOffset / 1000

    return visibleRange
      ? {
          from: visibleRange.from - offset,
          to: visibleRange.to - offset
        }
      : null
  }

  /**
   * get the optimal range for realtime bars
   * @return {number} range
   */
  getRealtimeRange() {
    const optimalRange = this.getOptimalRangeLength()
    let to = +new Date() / 1000
    let from = Math.ceil(to / store.state.settings.timeframe) * store.state.settings.timeframe - optimalRange

    return { from, to, median: from + (to - from) / 2, incomplete: true }
  }

  /**
   * get optimal range (difference between to and from) based on current timeframe, container dimensions and bar width
   * @return {number} range
   */
  getOptimalRangeLength() {
    return (
      Math.floor(
        ((this.chartElement.offsetWidth / this.chartInstance.options().timeScale.barSpacing) * store.state.settings.timeframe) /
          store.state.settings.timeframe
      ) * store.state.settings.timeframe
    )
  }

  /**
   * is chart contains rendered stuff
   */
  isEmpty() {
    return !this.chartInstance.timeScale().getVisibleRange()
  }

  /**
   * clear rendered stuff
   */
  clearChart() {
    console.log(`[chart/controller] clear chart (all series emptyed)`)

    this.preventPan()

    for (let serie of this.activeSeries) {
      this.clearSerie(serie)
    }

    this.renderedRange.from = this.renderedRange.to = null
  }

  /**
   * clear active data
   */
  clearData() {
    console.log(`[chart/controller] clear data (activeRenderer+activeChunk+queuedTrades1)`)

    this.activeRenderer = null
    this.activeChunk = null
    this.queuedTrades.splice(0, this.queuedTrades.length)
  }

  /**
   * clear data and rendered stuff
   */
  clear() {
    console.log(`[chart/controller] clear all (cache+activedata+chart)`)

    clearCache()
    this.clearData()
    this.clearChart()
  }

  /**
   * clear everything
   */
  destroy() {
    console.log(`[chart/controller] destroy`)

    clearCache()
    this.clearData()
    this.clearChart()
    this.removeChart()
    this.clearQueue()
  }

  /**
   * @param {ActiveSerie} serie serie to clear
   */
  clearSerie(serie) {
    serie.api.setData([])
  }

  /**
   * start queuing next trades
   */
  setupQueue() {
    if (this._releaseQueueInterval || !store.state.settings.chartRefreshRate) {
      return
    }

    console.log(`[chart/controller] setup queue (${getHms(store.state.settings.chartRefreshRate)})`)

    this._releaseQueueInterval = setInterval(() => {
      if (!this.preventImmediateRender) {
        this.releaseQueue()
      }
    }, store.state.settings.chartRefreshRate)
  }

  /**
   * release queue and stop queuing next trades
   */
  clearQueue() {
    if (!this._releaseQueueInterval) {
      return
    }

    console.log(`[chart/controller] clear queue`)

    clearInterval(this._releaseQueueInterval)
    delete this._releaseQueueInterval

    this.releaseQueue()
  }

  /**
   * pull trades from queue and render them immediately
   */
  releaseQueue() {
    if (!this.queuedTrades.length || this.preventRender) {
      return
    }

    this.renderRealtimeTrades(this.queuedTrades)
    this.queuedTrades.splice(0, this.queuedTrades.length)
  }

  /**
   * unlock render, will release queue on next queueInterval
   */
  unlockRender() {
    this.preventRender = false
  }

  /**
   * temporarily disable render to avoid issues
   */
  lockRender() {
    this.preventRender = true
  }

  /**
   * push a set of trades to queue in order to render them later
   * @param {Trades[]} trades
   */
  queueTrades(trades) {
    Array.prototype.push.apply(this.queuedTrades, trades)
  }

  /**
   * take a set of trades, group them into bars while using activeRenderer for reference and render them
   * also cache finished bar
   * @param {Trade[]} trades trades to render
   */
  renderRealtimeTrades(trades) {
    const formatedBars = []

    if (!trades.length) {
      return
    }

    let i = 0

    for (i; i < trades.length; i++) {
      const trade = trades[i]
      const timestamp = Math.floor(trade.timestamp / 1000 / store.state.settings.timeframe) * store.state.settings.timeframe

      if (!this.activeRenderer || this.activeRenderer.timestamp < timestamp) {
        if (this.activeRenderer) {
          if (!this.activeChunk || (this.activeChunk.to < this.activeRenderer.timestamp && this.activeChunk.bars.length >= MAX_BARS_PER_CHUNKS)) {
            if (!this.activeChunk) {
              console.log(`[chart/renderRealtimeTrades] formatbar require require active chunk`)
            } else {
              console.log(`[chart/renderRealtimeTrades] current active chunk is too large (${this.activeChunk.bars.length} bars)`)
            }

            if (!this.activeChunk && cacheRange.to === this.activeRenderer.timestamp) {
              cache[cache.length - 1].active = true
              this.activeChunk = cache[cache.length - 1]
              this.activeChunk.active = true
              console.log(`\t-> set last chunk as activeChunk (same timestamp, ${this.activeChunk.bars.length} bars)`)
            } else {
              if (this.activeChunk) {
                console.log(
                  `\t-> mark current active chunk as inactive (#${cache.indexOf(this.activeChunk)} | FROM: ${formatTime(
                    this.activeChunk.from
                  )} | TO: ${formatTime(this.activeChunk.to)})\n\t-> then create new chunk as activeChunk`
                )
                this.activeChunk.active = false
              }

              this.activeChunk = saveChunk({
                from: this.activeRenderer.timestamp,
                to: this.activeRenderer.timestamp,
                active: true,
                rendered: true,
                bars: []
              })

              console.log(
                `[chart/renderRealtimeTrades] create new active chunk (#${cache.indexOf(this.activeChunk)} | FROM: ${formatTime(
                  this.activeChunk.from
                )} | TO: ${formatTime(this.activeChunk.to)})`
              )
            }
          }

          if (this.activeRenderer.hasData) {
            formatedBars.push(this.computeBar(this.activeRenderer))
          }

          // feed activeChunk with active bar exchange snapshot
          for (let exchange in this.activeRenderer.exchanges) {
            if (this.activeRenderer.exchanges[exchange].hasData) {
              this.activeChunk.bars.push(this.cloneBar(this.activeRenderer.exchanges[exchange], this.activeRenderer.timestamp))
            }
          }

          this.activeChunk.to = cacheRange.to = this.activeRenderer.timestamp

          if (this.renderedRange.to < this.activeRenderer.timestamp) {
            this.renderedRange.to = this.activeRenderer.timestamp
          }

          this.nextBar(timestamp, this.activeRenderer)
        } else {
          this.activeRenderer = this.newBar(timestamp)
        }

        this.preventPan()
      }

      const amount = trade.price * trade.size

      if (!this.activeRenderer.exchanges[trade.exchange]) {
        this.activeRenderer.exchanges[trade.exchange] = {
          exchange: trade.exchange,
          close: +trade.price
        }

        this.resetBar(this.activeRenderer.exchanges[trade.exchange])
      }

      this.activeRenderer.exchanges[trade.exchange].hasData = true

      const isActive = store.state.app.actives.indexOf(trade.exchange) !== -1

      if (trade.liquidation) {
        this.activeRenderer.exchanges[trade.exchange]['l' + trade.side] += amount

        if (isActive) {
          this.activeRenderer['l' + trade.side] += amount
          this.activeRenderer.hasData = true
        }

        continue
      }

      this.activeRenderer.exchanges[trade.exchange].high = Math.max(this.activeRenderer.exchanges[trade.exchange].high, +trade.price)
      this.activeRenderer.exchanges[trade.exchange].low = Math.min(this.activeRenderer.exchanges[trade.exchange].low, +trade.price)
      this.activeRenderer.exchanges[trade.exchange].close = +trade.price

      this.activeRenderer.exchanges[trade.exchange]['c' + trade.side]++
      this.activeRenderer.exchanges[trade.exchange]['v' + trade.side] += amount

      if (isActive) {
        this.activeRenderer['v' + trade.side] += amount
        this.activeRenderer['c' + trade.side]++
        this.activeRenderer.hasData = true
      }
    }

    if (this.activeRenderer.hasData) {
      formatedBars.push(this.computeBar(this.activeRenderer))

      if (this.renderedRange.to < this.activeRenderer.timestamp) {
        this.renderedRange.to = this.activeRenderer.timestamp
      }
    }

    for (let i = 0; i < formatedBars.length; i++) {
      this.updateBar(formatedBars[i])
    }
  }

  /**
   * turn a set of trades into a set of bars according to current timeframe
   * @param {Trade[]} trades trades to group
   * @returns {Bar[]} bars to cache / render
   */
  groupTradesIntoBars(trades) {
    if (!trades.length) {
      return
    }

    let bar = {
      timestamp: null,
      exchanges: {}
    }

    let exchangesCount = 0
    const enabledExchanges = Object.keys(store.state.settings.exchanges).filter(a => !store.state.settings.exchanges[a].disabled)

    for (let i = 0; i < trades.length; i++) {
      if (!bar.exchanges[trades[i][0]] && enabledExchanges.indexOf(trades[i][0]) !== -1) {
        exchangesCount++
        bar.exchanges[trades[i][0]] = {
          exchange: trades[i][0],
          close: +trades[i][2]
        }

        this.resetBar(bar.exchanges[trades[i][0]])
        if (exchangesCount === enabledExchanges.length) {
          break
        }
      }
    }

    if (exchangesCount !== enabledExchanges.length) {
      console.log(`[groupTradesIntoBars] couldn't find all exchange's first price (${trades.length} processed)`)
    }

    const bars = []

    // loop through bars in range
    for (let j = 0; j <= trades.length; j++) {
      const timestamp = trades[j] ? Math.floor(trades[j][1] / 1000 / store.state.settings.timeframe) * store.state.settings.timeframe : Infinity

      if (bar.timestamp < timestamp) {
        for (let exchange in bar.exchanges) {
          if (bar.timestamp && bar.exchanges[exchange].hasData) {
            bars.push(this.cloneBar(bar.exchanges[exchange], bar.timestamp))
            this.resetBar(bar.exchanges[exchange])
          }
        }

        if (!trades[j]) {
          break
        }

        bar.timestamp = timestamp
      }

      const exchange = trades[j][0]

      if (!bar.exchanges[exchange]) {
        continue
      }

      const side = trades[j][4] > 0 ? 'buy' : 'sell'

      bar.exchanges[exchange].hasData = true

      if (trades[j][5] === 1) {
        bar.exchanges[exchange]['l' + side] += trades[j][3] * trades[j][2]
        continue
      }

      bar.exchanges[exchange].high = Math.max(bar.exchanges[exchange].high, +trades[j][2])
      bar.exchanges[exchange].low = Math.min(bar.exchanges[exchange].low, +trades[j][2])
      bar.exchanges[exchange].close = +trades[j][2]

      bar.exchanges[exchange]['c' + side]++
      bar.exchanges[exchange]['v' + side] += trades[j][3] * trades[j][2]
    }

    if (!bars.length) {
      return false
    }

    const from = Math.floor(bars[0].timestamp / store.state.settings.timeframe) * store.state.settings.timeframe
    const to = Math.floor(bars[bars.length - 1].timestamp / store.state.settings.timeframe) * store.state.settings.timeframe
    const median = from + (to - from) / 2

    const lastTimestamp = trades[trades.length - 1][1] / 1000

    return { from, to, median, bars, lastTimestamp }
  }

  /**
   * create a new object from an existing bar
   * to avoid reference when storing finished bar data to cache
   * @param {Bar} bar do copy
   * @param {number} [timestamp] apply timestamp to returned bar
   */
  cloneBar(bar, timestamp) {
    const barData = {
      exchange: bar.exchange,
      timestamp: timestamp || bar.timestamp,
      open: bar.open,
      high: bar.high,
      low: bar.low,
      close: bar.close,
      vbuy: bar.vbuy,
      vsell: bar.vsell,
      cbuy: bar.cbuy,
      csell: bar.csell,
      lbuy: bar.lbuy,
      lsell: bar.lsell
    }

    return barData
  }

  /**
   * Render a set of bars
   *
   * @param {Bar[]} bars bars to render
   * @param {string[]} [series] render only theses series
   */
  renderBars(bars, series) {
    console.log(`[chart/controller] render bars`, '(', series ? 'specific serie(s): ' + series.join(',') : 'all series', ')', bars.length, 'bar(s)')

    if (!bars.length) {
      return
    }

    const computedSeries = {}
    let from = null
    let to = null

    let temporaryRenderer

    for (let i = 0; i <= bars.length; i++) {
      const bar = bars[i]

      if (!bar || !temporaryRenderer || bar.timestamp > temporaryRenderer.timestamp) {
        if (temporaryRenderer && temporaryRenderer.hasData) {
          if (from === null) {
            from = temporaryRenderer.timestamp
          }

          to = temporaryRenderer.timestamp

          const computedBar = this.computeBar(temporaryRenderer, series)

          for (let id in computedBar) {
            if (typeof computedSeries[id] === 'undefined') {
              computedSeries[id] = []
            }

            computedSeries[id].push(computedBar[id])
          }
        }

        if (!bar) {
          break
        }

        if (temporaryRenderer) {
          this.nextBar(bar.timestamp, temporaryRenderer)
        } else {
          temporaryRenderer = this.newBar(bar.timestamp, series)
        }
      }

      if (store.state.app.actives.indexOf(bar.exchange) === -1) {
        continue
      }

      temporaryRenderer.hasData = true
      temporaryRenderer.vbuy += bar.vbuy
      temporaryRenderer.vsell += bar.vsell
      temporaryRenderer.cbuy += bar.cbuy
      temporaryRenderer.csell += bar.csell
      temporaryRenderer.lbuy += bar.lbuy
      temporaryRenderer.lsell += bar.lsell

      temporaryRenderer.exchanges[bar.exchange] = this.cloneBar(bar)
    }

    if (!series) {
      this.clearChart()

      if (!bars.length) {
        this.renderedRange.from = this.renderedRange.to = null
      } else {
        this.renderedRange.from = from
        this.renderedRange.to = to
      }
    }

    this.replaceData(computedSeries)

    /* if (!series) {
      const setSP = length * -1 || 16

      this.chartInstance.timeScale().scrollToPosition(setSP)
      console.log('rendered', length, 'bars, so scroll to position ', length + ' * -1 || 16', '=' + setSP)
    } */

    if (this.activeRenderer) {
      for (let id in temporaryRenderer.series) {
        console.log('override active renderer serie', id)

        this.activeRenderer.series[id] = temporaryRenderer.series[id]
      }
    } else {
      this.activeRenderer = temporaryRenderer
    }
  }

  /**
   * Renders chunks that collides with visible range
   */
  renderVisibleChunks() {
    if (!cache.length || !this.chartInstance) {
      return
    }

    const visibleRange = this.chartInstance.timeScale().getVisibleRange()

    if (visibleRange) {
      console.log('[chart/renderVisibleChunks] VisibleRange: ', `from: ${formatTime(visibleRange.from)} -> to: ${formatTime(visibleRange.to)}`)
    }

    let selection = ['------------------------']
    const bars = cache
      .filter(c => {
        c.rendered = !visibleRange || c.to > visibleRange.from - store.state.settings.timeframe * 20
        selection.push(
          `${c.rendered ? '[selected] ' : ''} #${cache.indexOf(c)} | FROM: ${formatTime(c.from)} | TO: ${formatTime(c.to)} (${formatAmount(
            c.bars.length
          )} bars)`
        )

        return c.rendered
      })
      .reduce((bars, chunk) => bars.concat(chunk.bars), [])
    selection.push('------------------------')
    console.log(selection.join('\n') + '\n')
    this.renderBars(bars, null)
  }

  /**
   * Attach marker to serie
   * @param {ActiveSerie} serie serie
   */
  setMarkers(serie, marker) {
    if (!serie.markers) {
      serie.markers = []
    }

    for (let i = serie.markers.length - 1; i >= 0; i--) {
      if (serie.markers[i].time === marker.time) {
        serie.markers.splice(i, 1)
        break
      }
    }

    serie.markers.push(marker)

    setTimeout(() => {
      serie.api.setMarkers(serie.markers)
    }, 100)
  }

  /**
   * disable "fetch on pan" until current operation (serie.update / serie.setData) is finished
   */
  preventPan() {
    if (this.panPrevented) {
      return
    }

    const delay = 1000

    // console.info(`[chart/controller] prevent pan for next ${getHms(delay)}`)

    if (typeof this._releasePanTimeout !== 'undefined') {
      clearTimeout(this._releasePanTimeout)
    }

    this.panPrevented = true

    this._releasePanTimeout = window.setTimeout(() => {
      if (!this.panPrevented) {
        // console.warn(`[chart/controller] pan already released (before timeout fired)`)
      } else {
        // console.info(`[chart/controller] pan released (by timeout)`)

        this.panPrevented = false
      }
    }, delay)
  }

  /**
   * replace whole chart with a set of bars
   * @param {Bar[]} bars bars to render
   */
  replaceData(computedSeries) {
    this.preventPan()

    for (let serie of this.activeSeries) {
      if (computedSeries[serie.id] && computedSeries[serie.id].length) {
        serie.api.setData(computedSeries[serie.id])
      }
    }
  }

  /**
   * update last or add new bar to this.chartInstance
   * @param {Bar} bar
   */
  updateBar(bar) {
    for (let serie of this.activeSeries) {
      if (bar[serie.id]) {
        serie.api.update(bar[serie.id])
      }
    }
  }

  /**
   * Process bar data and compute series values for this bar
   * @param {Bar} bar
   * @param {{[id: string]: TV.BarData | TV.LineData}} series
   */
  computeBar(bar, series) {
    const points = {}

    for (let serie of this.activeSeries) {
      if (series && series.indexOf(serie.id) === -1) {
        continue
      }

      const serieData = bar.series[serie.id]

      serieData.point = serie.adapter(bar, serie.options)

      if (serieData.point.value || serieData.point.open) {
        points[serie.id] = { time: bar.timestamp + store.state.settings.timezoneOffset / 1000, ...serieData.point }
      }
    }

    return points
  }

  /**
   * Create empty renderer
   * @param {number} timestamp start timestamp
   * @param {string[]} series series to bind
   */
  newBar(timestamp, series) {
    const renderer = {
      timestamp: timestamp,
      series: {},
      exchanges: {},
      open: null,
      high: null,
      low: null,
      close: null,
      vbuy: 0,
      vsell: 0,
      cbuy: 0,
      csell: 0,
      lbuy: 0,
      lsell: 0
    }

    for (let serie of this.activeSeries) {
      if (series && series.indexOf(serie.id) === -1) {
        continue
      }

      this.bindSerie(serie, renderer)
    }

    return renderer
  }

  /**
   * prepare bar for next timestamp
   * @param {number} timestamp timestamp of the next bar
   * @param {Renderer?} renderer bar to use as reference
   */
  nextBar(timestamp, renderer) {
    if (renderer.hasData) {
      for (let i = 0; i < this.activeSeries.length; i++) {
        const barSerieData = renderer.series[this.activeSeries[i].id]

        if (!barSerieData) {
          continue
        }

        barSerieData.value = barSerieData.point.value || barSerieData.point.close

        if (barSerieData.memory) {
          for (let i = 0; i < barSerieData.memory.length; i++) {
            const fn = barSerieData.memory[i]

            fn.points.push(fn.output)
            fn.sum += fn.output
            fn.count++

            if (fn.count > fn.length) {
              fn.sum -= fn.points.shift()
              fn.count--
            }
          }
        }

        if (barSerieData.memoryThis) {
          if (typeof barSerieData.memoryThis.open !== 'undefined') {
            barSerieData.memoryThis.open = barSerieData.memoryThis.close
            barSerieData.memoryThis.high = barSerieData.memoryThis.close
            barSerieData.memoryThis.low = barSerieData.memoryThis.close
          }
        }
      }
    }

    renderer.timestamp = timestamp

    this.resetBar(renderer)
  }

  /**
   * @param {Bar | ActiveBar} bar bar to clear for next timestamp
   */
  resetBar(bar) {
    bar.open = bar.close
    bar.high = bar.close
    bar.low = bar.close
    bar.vbuy = 0
    bar.vsell = 0
    bar.cbuy = 0
    bar.csell = 0
    bar.lbuy = 0
    bar.lsell = 0
    bar.hasData = false

    if (bar.exchanges) {
      for (let exchange in bar.exchanges) {
        this.resetBar(bar.exchanges[exchange])
      }
    }
  }

  getChartColorOptions(color) {
    let borderColor = toRgb(color)

    borderColor.alpha = 0.2
    borderColor = formatRgb(borderColor)

    return {
      layout: {
        textColor: color,
        borderColor
      },
      priceScale: {
        borderColor
      },
      timeScale: {
        borderColor
      }
    }
  }

  setChartColor(color) {
    this.chartInstance.applyOptions(this.getChartColorOptions(color))
  }
}