export default {
  price: {
    type: 'candlestick',
    input: `ohlc_avg_price(bar)`,
    options: {
      priceScaleId: 'price',
      priceLineColor: 'rgba(255, 255, 255, .5)',
      priceLineWidth: 1,
      priceLineStyle: 2,
      lastValueVisible: true,
      priceLineVisible: true,
      borderVisible: false,
      scaleMargins: {
        top: 0,
        bottom: 0
      }
    }
  },
  volume_sell_ema: {
    type: 'line',
    input: `ema(bar.vsell,options.ema_length)`,
    options: {
      valueAsVolume: true,
      ema_length: 14,
      priceScaleId: 'volume_ema',
      color: '#c14047',
      lineWidth: 2,
      scaleMargins: {
        top: 0.8,
        bottom: 0
      }
    }
  },
  volume_buy_ema: {
    type: 'line',
    input: `ema(bar.vbuy, options.ema_length)`,
    options: {
      valueAsVolume: true,
      ema_length: 14,
      priceScaleId: 'volume_ema',
      color: '#c9b087',
      lineWidth: 2,
      scaleMargins: {
        top: 0.8,
        bottom: 0
      }
    }
  },
  volume_delta: {
    type: 'histogram',
    input: `{
      value: Math.abs(bar.vbuy-bar.vsell),
      color: bar.vbuy - bar.vsell > 0 ? options.upColor : options.downColor
    }`,
    options: {
      valueAsVolume: true,
      upColor: '#c3a87a',
      downColor: '#e53935',
      priceScaleId: 'volume'
    }
  },
  volume: {
    type: 'histogram',
    input: `bar.vbuy + bar.vsell`,
    options: {
      valueAsVolume: true,
      color: 'rgba(255, 255, 255, .15)',
      priceScaleId: 'volume'
    }
  },
  liquidations: {
    type: 'histogram',
    input: `bar.lbuy + bar.lsell`,
    options: {
      valueAsVolume: true,
      priceScaleId: 'volume',
      color: '#9c27b0'
    }
  },
  cvd: {
    type: 'line',
    input: `ohlc((this.open || 0) + (bar.vbuy - bar.vsell))`,
    options: {
      priceScaleId: 'left',
      valueAsVolume: true,
      lastValueVisible: true,
      priceLineVisible: true,
      priceLineColor: 'rgba(255, 235, 59, .75)',
      color: '#ffffff',
      lineWidth: 2,
      scaleMargins: {
        top: 0.1,
        bottom: 0.2
      },
      priceFormat: {
        type: 'volume',
        precision: 3,
        minMove: 0.05
      }
    }
  },
  ctd: {
    type: 'line',
    input: `bar.series.ctd.value + (bar.cbuy - bar.csell)`,
    options: {
      priceScaleId: 'overlay2',
      valueAsVolume: true,
      color: '#ffffff',
      lineWidth: 1,
      lineStyle: 2,
      scaleMargins: {
        top: 0.1,
        bottom: 0.2
      }
    }
  },
  price_sma: {
    type: 'line',
    input: `sma(bar.series.price.point.close,options.length)`,
    options: {
      color: 'rgba(52,100,69,0.38)',
      length: 50,
      lineWidth: 2
    }
  },
  price_sma2: {
    type: 'line',
    input: `sma(bar.series.price.point.close,options.length)`,
    options: {
      color: 'rgba(52,100,69,0.38)',
      length: 50,
      lineWidth: 2
    }
  },
  price_cma: {
    type: 'line',
    input: `cma(bar.series.price.point.close,options.length)`,
    options: {
      length: 21,
      color: '#8c61f5',
      lineWidth: 2
    }
  },
  price_cma2: {
    type: 'line',
    input: `cma(bar.series.price.point.close,options.length)`,
    options: {
      length: 21,
      color: '#8c61f5',
      lineWidth: 2
    }
  }
}