require('dotenv').config()

module.exports = {
  deployments: {
    netId100: {
      xdai: {
        instanceAddress: {
          '1': '',
          '1000': '',
          '10000': '',
          '100000': ''
        },
        symbol: 'XDAI',
        decimals: 18
      }
    }
    // ,
    // netId1666700000: {
    //   eth: {
    //     instanceAddress: {
    //       '10': '',
    //       '100': '',
    //       '1000': '',
    //       '10000': '',
    //       '100000': '',
    //     },
    //     symbol: 'ONE',
    //     decimals: 18
    //   }
    // }
  }
}
