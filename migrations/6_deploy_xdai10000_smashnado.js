/* global artifacts */
require('dotenv').config({ path: '../.env' })
const XDAISmashnado = artifacts.require('XDAISmashnado')
const Verifier = artifacts.require('Verifier')
const hasherContract = artifacts.require('Hasher')


module.exports = function(deployer, network, accounts) {
  return deployer.then(async () => {
    const { MERKLE_TREE_HEIGHT, XDAI_AMOUNT_TT } = process.env
    const verifier = await Verifier.deployed()
    const hasherInstance = await hasherContract.deployed()
    await XDAISmashnado.link(hasherContract, hasherInstance.address)
    const smashnado = await deployer.deploy(XDAISmashnado, verifier.address, XDAI_AMOUNT_TT, MERKLE_TREE_HEIGHT, accounts[0])
    console.log('XDAI Smashnado\'s address ', smashnado.address)
  })
}
