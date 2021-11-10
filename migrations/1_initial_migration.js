/* global artifacts */
const Migrations = artifacts.require('Migrations')

module.exports = function(deployer) {
  if(deployer.network === 'xdai') {
    return
  }
  deployer.deploy(Migrations)
}
