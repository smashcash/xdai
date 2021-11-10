#!/usr/bin/env node
// Temporary demo client
// Works both in browser and node.js

require('dotenv').config()
const fs = require('fs')
const axios = require('axios')
const assert = require('assert')
const snarkjs = require('snarkjs')
const crypto = require('crypto')
const circomlib = require('circomlib')
const bigInt = snarkjs.bigInt
const merkleTree = require('./lib/MerkleTree')
const Web3 = require('web3')
const buildGroth16 = require('websnark/src/groth16')
const websnarkUtils = require('websnark/src/utils')
const { toWei, fromWei, toBN, BN } = require('web3-utils')
const config = require('./config')
const program = require('commander')
const console = require('console')

let web3, smashnado, smashnadoAddress, circuit, proving_key, groth16, erc20, senderAccount, netId
let MERKLE_TREE_HEIGHT, ETH_AMOUNT, TOKEN_AMOUNT, PRIVATE_KEY
let contractJson, erc20ContractJson

/** Whether we are in a browser or node.js */
const inBrowser = (typeof window !== 'undefined')
let isLocalRPC = false

/** Generate random number of specified byte length */
const rbigint = nbytes => snarkjs.bigInt.leBuff2int(crypto.randomBytes(nbytes))

/** Compute pedersen hash */
const pedersenHash = data => circomlib.babyJub.unpackPoint(circomlib.pedersenHash.hash(data))[0]

/** BigNumber to hex string of specified length */
function toHex(number, length = 32) {
  const str = number instanceof Buffer ? number.toString('hex') : bigInt(number).toString(16)
  return '0x' + str.padStart(length * 2, '0')
}

/** Display ETH account balance */
async function printETHBalance({ address, name }) {
  console.log(`${name} XDAI balance is`, web3.utils.fromWei(await web3.eth.getBalance(address)))
}

/** Display ERC20 account balance */
async function printERC20Balance({ address, name, tokenAddress }) {
  erc20ContractJson = require('./build/contracts/ERC20Mock.json')
  erc20 = tokenAddress ? new web3.eth.Contract(erc20ContractJson.abi, tokenAddress) : erc20
  console.log(`${name} Token Balance is`, web3.utils.fromWei(await erc20.methods.balanceOf(address).call()))
}

/**
 * Create deposit object from secret and nullifier
 */
function createDeposit({ nullifier, secret }) {
  const deposit = { nullifier, secret }
  deposit.preimage = Buffer.concat([deposit.nullifier.leInt2Buff(31), deposit.secret.leInt2Buff(31)])
  deposit.commitment = pedersenHash(deposit.preimage)
  deposit.commitmentHex = toHex(deposit.commitment)
  deposit.nullifierHash = pedersenHash(deposit.nullifier.leInt2Buff(31))
  deposit.nullifierHex = toHex(deposit.nullifierHash)
  return deposit
}

/**
 * Make a deposit
 * @param currency Сurrency
 * @param amount Deposit amount
 */
async function deposit({ currency, amount }) {
  const deposit = createDeposit({ nullifier: rbigint(31), secret: rbigint(31) })
  const note = toHex(deposit.preimage, 62)
  const noteString = `smashcash-${currency}-${amount}-${netId}-${note}`
  console.log(`Your note: ${noteString}`)
  w_display_loader_message('Creating Secret Key ... ')
  if (currency === 'xdai') {
    await printETHBalance({ address: smashnado._address, name: 'Smashcash' })
    await printETHBalance({ address: senderAccount, name: 'Sender account' })
    const value = fromDecimals({ amount, decimals: 18 })
    console.log('Submitting deposit transaction')
    w_display_loader_message('Submitting deposit transaction.')
    // to avoid lost secret key
    download_note('secret_key_' + currency + '_' + amount + '.txt', noteString)

    await smashnado.methods.deposit(toHex(deposit.commitment)).send({ value, from: senderAccount, gas: 2e6 })
    await printETHBalance({ address: smashnado._address, name: 'Smashcash' })
    await printETHBalance({ address: senderAccount, name: 'Sender account' })
    console.log('Deposit successful.')
    w_display_loader_message('Deposit successful.')

  } else { // a token
    await printERC20Balance({ address: smashnado._address, name: 'Smashcash' })
    await printERC20Balance({ address: senderAccount, name: 'Sender account' })
    const decimals = isLocalRPC ? 18 : config.deployments[`netId${netId}`][currency].decimals
    const tokenAmount = isLocalRPC ? TOKEN_AMOUNT : fromDecimals({ amount, decimals })
    if (isLocalRPC) {
      console.log('Minting some test tokens to deposit')
      await erc20.methods.mint(senderAccount, tokenAmount).send({ from: senderAccount, gas: 2e6 })
    }

    const allowance = await erc20.methods.allowance(senderAccount, smashnado._address).call({ from: senderAccount })
    console.log('Current allowance is', fromWei(allowance))
    if (toBN(allowance).lt(toBN(tokenAmount))) {
      console.log('Approving tokens for deposit')
      await erc20.methods.approve(smashnado._address, tokenAmount).send({ from: senderAccount, gas: 1e6 })
    }

    console.log('Submitting deposit transaction')
    await smashnado.methods.deposit(toHex(deposit.commitment)).send({ from: senderAccount, gas: 2e6 })
    await printERC20Balance({ address: smashnado._address, name: 'Smashcash' })
    await printERC20Balance({ address: senderAccount, name: 'Sender account' })
    console.log('Deposit successful.')
  }

  return noteString
}

/**
 * Generate merkle tree for a deposit.
 * Download deposit events from the smashnado, reconstructs merkle tree, finds our deposit leaf
 * in it and generates merkle proof
 * @param deposit Deposit object
 */
async function generateMerkleProof(deposit) {
  // Get all deposit events from smart contract and assemble merkle tree from them
  console.log('Getting current state from Smashcash contract')
  w_display_loader_message('Getting current state from Smashcash contract')
  const allEvents = await smashnado.getPastEvents('Deposit', { fromBlock: 	0, toBlock: 	'latest' })

  const leaves = allEvents
    .sort((a, b) => a.returnValues.leafIndex - b.returnValues.leafIndex) // Sort events in chronological order
    .map(e => e.returnValues.commitment)
  const tree = new merkleTree(MERKLE_TREE_HEIGHT, leaves)
  // Find current commitment in the tree
  const depositEvent = allEvents.find(e => e.returnValues.commitment === toHex(deposit.commitment))
  const leafIndex = depositEvent ? depositEvent.returnValues.leafIndex : -1
  // Validate that our data is correct
  const root = await tree.root()
  const isValidRoot = await smashnado.methods.isKnownRoot(toHex(root)).call()
  const isSpent = await smashnado.methods.isSpent(toHex(deposit.nullifierHash)).call()

  assert(isValidRoot === true, 'Merkle tree is corrupted')
  assert(isSpent === false, 'The secret key is already spent')
  assert(leafIndex >= 0, 'The deposit is not found in the tree')

  // Compute merkle proof of our commitment
  return tree.path(leafIndex)
}

/**
 * Generate SNARK proof for withdrawal
 * @param deposit Deposit object
 * @param recipient Funds recipient
 * @param relayer Relayer address
 * @param fee Relayer fee
 * @param refund Receive ether for exchanged tokens
 */
async function generateProof({ deposit, recipient, relayerAddress = 0, fee = 0, refund = 0 }) {
  // Compute merkle proof of our commitment
  const { root, path_elements, path_index } = await generateMerkleProof(deposit)

  // Prepare circuit input
  const input = {
    // Public snark inputs
    root: root,
    nullifierHash: deposit.nullifierHash,
    recipient: bigInt(recipient),
    relayer: bigInt(relayerAddress),
    fee: bigInt(fee),
    refund: bigInt(refund),

    // Private snark inputs
    nullifier: deposit.nullifier,
    secret: deposit.secret,
    pathElements: path_elements,
    pathIndices: path_index,
  }

  console.log('Generating SNARK proof')
  w_display_loader_message('Generating SNARK proof')
  console.time('Proof time')
  const proofData = await websnarkUtils.genWitnessAndProve(groth16, input, circuit, proving_key)
  const { proof } = websnarkUtils.toSolidityInput(proofData)
  console.timeEnd('Proof time')

  const args = [
    toHex(input.root),
    toHex(input.nullifierHash),
    toHex(input.recipient, 20),
    toHex(input.relayer, 20),
    toHex(input.fee),
    toHex(input.refund)
  ]

  return { proof, args }
}

/**
 * Do an ETH withdrawal
 * @param noteString Note to withdraw
 * @param recipient Recipient address
 */
async function withdraw({ deposit, currency, amount, recipient, relayerURL, refund = '0' }) {
  if (currency === 'xdai' && refund !== '0') {
    throw new Error('The ETH purchase is supposted to be 0 for ETH withdrawals')
  }
  refund = toWei(refund)
  if (relayerURL) {
    if (relayerURL.endsWith('.eth')) {
      throw new Error('ENS name resolving is not supported. Please provide DNS name of the relayer. See instuctions in README.md')
    }
    const relayerStatus = await axios.get(relayerURL + '/status')
    const { relayerAddress, netId, gasPrices, ethPrices, relayerServiceFee } = relayerStatus.data
    assert(netId === await web3.eth.net.getId() || netId === '*', 'This relay is for different network')
    console.log('Relay address: ', relayerAddress)

    const decimals = config.deployments[`netId${netId}`][currency].decimals
    const fee = calculateFee({ gasPrices, currency, amount, refund, ethPrices, relayerServiceFee, decimals })
    if (fee.gt(fromDecimals({ amount, decimals }))) {
      throw new Error('Too high refund')
    }
    const { proof, args } = await generateProof({ deposit, recipient, relayerAddress, fee, refund })

    console.log('Sending withdraw transaction through relay')
    try {
      const relay = await axios.post(relayerURL + '/relay', { contract: smashnado._address, proof, args })
      if (netId === 100) {
        console.log(`Transaction submitted through the relay. View transaction on xdaiscan https://blockscout.com/xdai/mainnet/`)
      } else {
        console.log(`Transaction submitted through the relay. The transaction hash is ${relay.data.txHash}`)
      }

      const receipt = await waitForTxReceipt({ txHash: relay.data.txHash })
      console.log('Transaction mined in block', receipt.blockNumber)
    } catch (e) {
      if (e.response) {
        console.error(e.response.data.error)
      } else {
        console.error(e.message)
      }
    }
  } else { // using private key
    const { proof, args } = await generateProof({ deposit, recipient, refund })
    w_display_loader_message('Submitting withdraw transaction')
    console.log('Submitting withdraw transaction')
    await smashnado.methods.withdraw(proof, ...args).send({ from: senderAccount, value: refund.toString(), gas: 1e6 })
      .on('transactionHash', function (txHash) {
        if (netId === 100) {
          console.log(`View transaction on xdaiscan https://blockscout.com/xdai/mainnet`)
        } else {
          console.log(`The transaction hash is ${txHash}`)
        }
      }).on('error', function (e) {
        console.error('on transactionHash error', e.message)
      })
  }
  w_display_loader_message('Done')
  console.log('Done')
  return true
}

function fromDecimals({ amount, decimals }) {
  amount = amount.toString()
  let ether = amount.toString()
  const base = new BN('10').pow(new BN(decimals))
  const baseLength = base.toString(10).length - 1 || 1

  const negative = ether.substring(0, 1) === '-'
  if (negative) {
    ether = ether.substring(1)
  }

  if (ether === '.') {
    throw new Error('[ethjs-unit] while converting number ' + amount + ' to wei, invalid value')
  }

  // Split it into a whole and fractional part
  const comps = ether.split('.')
  if (comps.length > 2) {
    throw new Error(
      '[ethjs-unit] while converting number ' + amount + ' to wei,  too many decimal points'
    )
  }

  let whole = comps[0]
  let fraction = comps[1]

  if (!whole) {
    whole = '0'
  }
  if (!fraction) {
    fraction = '0'
  }
  if (fraction.length > baseLength) {
    throw new Error(
      '[ethjs-unit] while converting number ' + amount + ' to wei, too many decimal places'
    )
  }

  while (fraction.length < baseLength) {
    fraction += '0'
  }

  whole = new BN(whole)
  fraction = new BN(fraction)
  let wei = whole.mul(base).add(fraction)

  if (negative) {
    wei = wei.mul(negative)
  }

  return new BN(wei.toString(10), 10)
}

function toDecimals(value, decimals, fixed) {
  const zero = new BN(0)
  const negative1 = new BN(-1)
  decimals = decimals || 18
  fixed = fixed || 7

  value = new BN(value)
  const negative = value.lt(zero)
  const base = new BN('10').pow(new BN(decimals))
  const baseLength = base.toString(10).length - 1 || 1

  if (negative) {
    value = value.mul(negative1)
  }

  let fraction = value.mod(base).toString(10)
  while (fraction.length < baseLength) {
    fraction = `0${fraction}`
  }
  fraction = fraction.match(/^([0-9]*[1-9]|0)(0*)/)[1]

  const whole = value.div(base).toString(10)
  value = `${whole}${fraction === '0' ? '' : `.${fraction}`}`

  if (negative) {
    value = `-${value}`
  }

  if (fixed) {
    value = value.slice(0, fixed)
  }

  return value
}

function getCurrentNetworkName() {
  switch (netId) {
  case 1:
    return ''
  case 42:
    return 'kovan.'
  }

}

function calculateFee({ gasPrices, currency, amount, refund, ethPrices, relayerServiceFee, decimals }) {
  const decimalsPoint = Math.floor(relayerServiceFee) === Number(relayerServiceFee) ?
    0 :
    relayerServiceFee.toString().split('.')[1].length
  const roundDecimal = 10 ** decimalsPoint
  const total = toBN(fromDecimals({ amount, decimals }))
  const feePercent = total.mul(toBN(relayerServiceFee * roundDecimal)).div(toBN(roundDecimal * 100))
  const expense = toBN(toWei(gasPrices.fast.toString(), 'gwei')).mul(toBN(5e5))
  let desiredFee
  switch (currency) {
  case 'xdai': {
    desiredFee = expense.add(feePercent)
    break
  }
  default: {
    desiredFee = expense.add(toBN(refund))
      .mul(toBN(10 ** decimals))
      .div(toBN(ethPrices[currency]))
    desiredFee = desiredFee.add(feePercent)
    break
  }
  }
  return desiredFee
}

/**
 * Waits for transaction to be mined
 * @param txHash Hash of transaction
 * @param attempts
 * @param delay
 */
function waitForTxReceipt({ txHash, attempts = 60, delay = 1000 }) {
  return new Promise((resolve, reject) => {
    const checkForTx = async (txHash, retryAttempt = 0) => {
      const result = await web3.eth.getTransactionReceipt(txHash)
      if (!result || !result.blockNumber) {
        if (retryAttempt <= attempts) {
          setTimeout(() => checkForTx(txHash, retryAttempt + 1), delay)
        } else {
          reject(new Error('tx was not mined'))
        }
      } else {
        resolve(result)
      }
    }
    checkForTx(txHash)
  })
}

/**
 * Parses Smashnado.cash note
 * @param noteString the note
 */
function parseNote(noteString) {
  const noteRegex = /smashcash-(?<currency>\w+)-(?<amount>[\d.]+)-(?<netId>\d+)-0x(?<note>[0-9a-fA-F]{124})/g
  const match = noteRegex.exec(noteString)
  if (!match) {
    throw new Error('The note has invalid format')      
  }

  const buf = Buffer.from(match.groups.note, 'hex')
  const nullifier = bigInt.leBuff2int(buf.slice(0, 31))
  const secret = bigInt.leBuff2int(buf.slice(31, 62))
  const deposit = createDeposit({ nullifier, secret })
  const netId = Number(match.groups.netId)

  return { currency: match.groups.currency, amount: match.groups.amount, netId, deposit }
}

function w_start_loader() {
  document.getElementById('loader_div').style.display ='flex';
}

function w_end_loder() {
  document.getElementById('loader_div').style.display ='none';
}

function w_display_loader_message(_text) {
  $("#loader_msg").text(_text)
}

function w_display_notification(_text, _type) {
  $(".pop-msg" ).removeClass("hide")
  $('.pop-msg p span:eq(1)').html(_text)
  if (_type) {
    $(".pop-msg p" ).css('border','1px solid #ff0000')
  } else {
    $(".pop-msg p" ).css('border','1px solid #a17dc9')
  }
}

function w_init_notification() {
  $(".pop-msg" ).addClass("hide");
  $(".pop-msg p" ).css('border','1px solid #a17dc9;')
}

function validate_recipient(_recipient) {
  const recipRegex = /0x[a-fA-F0-9]{40}/g
  const match = recipRegex.exec(_recipient)

  if (!match) {
    throw new Error('The recipient invalid format')      
  }
}

function conert_timestamp(_timestamp){
  var date = new Date(_timestamp*1000);
  var dateStr = date.getFullYear() + "-" + (date.getMonth()+1) + "-" + date.getDate() + " "+date.getHours() + ":" + date.getMinutes() + ":" + date.getSeconds()
  return dateStr
}

function process_errormsg(error) {
  if (error == null) return false;
  if (typeof error === 'object') {
    if (error.message.includes('Internal JSON-RPC')) {
      w_display_notification('The RPC you have set may have traffic or rate-limits depending on usage. You can check it in <a style=\'color:#ff0000;position:initial;\'>SET RPC</a> menu.', 'error')
    } else {
      if (error.message.includes('RPC')) {
        w_display_notification('There is problem with your RPC. If you set correct RPC, please reload page', 'error')
      } else {
        w_display_notification(error.message, 'error')
      }            
    }  
  } else {
      w_display_notification(error, 'error')
  }
}

/**
 * Init web3, contracts, and snark
 */
async function init({ rpc, noteNetId, currency = 'xdai', amount = '1' }) {
  let erc20smashnadoJson, tokenAddress
  // TODO do we need this? should it work in browser really?
  console.log('Initializing ...')
  // Initialize using injected web3 (Metamask)
  // To assemble web version run `npm run browserify`
  try {
    if (web3 == undefined) {
      web3 = new Web3(window.ethereum, null, { transactionConfirmationBlocks: 1 })
      contractJson = await (await fetch('build/contracts/XDAISmashnado.json')).json()
      circuit = await (await fetch('build/circuits/withdraw.json')).json()
      proving_key = await (await fetch('build/circuits/withdraw_proving_key.bin')).arrayBuffer()
      MERKLE_TREE_HEIGHT = 20
      ETH_AMOUNT = 1e18
      TOKEN_AMOUNT = 1e19
      senderAccount = (await web3.eth.getAccounts())[0]

      erc20ContractJson = require('./build/contracts/ERC20Mock.json')
    }
    
  } catch (error) {
    if (window.web3)
      typeof error === 'object' ? alert(error.message) : alert(error)
    else
      alert('Cannot find wallet. Please install wallet like as MetaMask.')
  }
  
  if (groth16 === undefined) {
    // groth16 initialises a lot of Promises that will never be resolved, that's why we need to use process.exit to terminate the CLI
    groth16 = await buildGroth16()
  }
  
  
  netId = await web3.eth.net.getId()
  if (!(netId === 100)) {
    throw new Error('You did not connect to POA network. Please make sure you connected to POA Mainnet')
  }

  if (noteNetId && Number(noteNetId) !== netId) {
    throw new Error('This note is for a different network. Specify the --rpc option explicitly')
  }

  try {
    smashnadoAddress = config.deployments[`netId${netId}`][currency].instanceAddress[amount]
    if (!smashnadoAddress) {
      throw new Error('Create address error')
    }
    tokenAddress = config.deployments[`netId${netId}`][currency].tokenAddress
  } catch (e) {
    console.error('There is no such smashcash instance, check the currency and amount you provide')
    //process.exit(1)
  }
  smashnado = new web3.eth.Contract(contractJson.abi, smashnadoAddress)
  if (smashnado._address === null) throw new Error('You are in other Network. Please make sure you connected to POA Mainnet.')
  erc20 = currency !== 'xdai' ? new web3.eth.Contract(erc20ContractJson.abi, tokenAddress) : {}
}

async function main() {
  const instance = { currency: 'xdai', amount: '1' }
  //await init(instance)

  window.deposit = async (_currencyStr, _amountStr) => {
    // check balance is enough to deposit
    let senderBalance = web3.utils.fromWei(await web3.eth.getBalance(senderAccount))
    console.log(senderBalance)
    console.log(_amountStr)

    if ( parseFloat(senderBalance) < parseFloat(_amountStr) ) {
      w_display_notification('Insufficient XDAI Balance in your wallet to deposit.', 'error')
      return false;
    }

    const currencyStr = _currencyStr
    const amountStr = _amountStr
    const instanceFromWeb = { currency: currencyStr, amount: amountStr }
    try {
      // show loader
      w_start_loader()
      w_display_loader_message('Initializing ... ')
      w_init_notification()
      await init(instanceFromWeb)
      const noteString = await deposit(instanceFromWeb)
      // show modal for note string deposited to toronado
      if (noteString) {
        // hide loader
        w_end_loder()
        // show modal for note string
        $('#myModalForNote').css('display', 'flex')          
        $('#yourNotedCopy').val(noteString);
        var resultStr = 'Deposit successful.<br/>'
        resultStr += 'Sender account xDai balance is ' + web3.utils.fromWei(await web3.eth.getBalance(senderAccount)) +'<br/>'
        resultStr += 'Secret Code is automatically downloaded. Please check your download folder in your computer.'
        $('#myModalForNote div p:eq(1)').html(resultStr)

        // download_note('secret_key_' + currencyStr + '_' + amountStr + '.txt', noteString)
      }
    } catch (error) {
      if(error.code) {
        switch (error.code) {
          case 4001:
            process_errormsg('The request was rejected by the user')   
            break;
          case -32602:  
            process_errormsg('The parameters were invalid')   
          break;
          case -32603:  
            process_errormsg('The request was not processed by some reason. Please check wallet settings and retry again later.')   
          break;
        
          default:
            process_errormsg('The request was not processed by some reason.')   
        }
      } else {
        process_errormsg(error)   
      }
      // hide loader
      w_end_loder()                 
    }
    
  }
  window.withdraw = async (_noteString, _recipient) => {

    try {
      if (_noteString && _recipient) {
        const noteString = _noteString;
        const recipient = _recipient;
        const { currency, amount, netId, deposit } = parseNote(noteString)
        validate_recipient(recipient)

        // show loader
        w_start_loader()
        w_display_loader_message('Initializing ... ')
        w_init_notification()
        await init({ noteNetId: netId, currency, amount })
        await withdraw({ deposit, currency, amount, recipient })
        // hide loader
        w_end_loder()
        w_display_notification('Your withdrawal request is processed successfully.' + '<br/>' + 'Secret: ' + noteString + '<br/>' + 'Amount: ' + amount + currency.toUpperCase())
        $('#in_secret').val('');
        $('#in_recipient').val('');
      } else {
        w_display_notification('Enter the Secret and Recipient Address')
      }
    } catch (error) {
      if(error.code) {
        switch (error.code) {
          case 4001:
            process_errormsg('The request was rejected by the user')   
            break;
          case -32602:  
            process_errormsg('The parameters were invalid')   
          break;
          case -32603:  
            process_errormsg('The request was not processed by some reason. Please check wallet settings and retry again later.')   
          break;
        
          default:
            process_errormsg('The request was not processed by some reason.')   
        }
      } else {
        process_errormsg(error)   
      }
      // hide loader
      w_end_loder()            
    }
    
  }  
}

main()