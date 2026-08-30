const mineflayer = require('mineflayer')
const { pathfinder, Movements, goals } = require('mineflayer-pathfinder')
const pvp = require('mineflayer-pvp').plugin
const collectBlock = require('mineflayer-collectblock').plugin
const express = require('express')

const app = express()
app.get('/', (req, res) => res.send('KadooBot is online'))
app.listen(3000, () => console.log('Web server running'))

const bot = mineflayer.createBot({
  host: 'loobialimoosmp.aternos.me',
  port: 58114,
  username: 'KadooBot',
  version: '1.21.8',
  auth: 'offline'
})

bot.loadPlugin(pathfinder)
bot.loadPlugin(pvp)
bot.loadPlugin(collectBlock)

let following = null
let protecting = false

bot.once('spawn', () => {
  console.log('KadooBot joined!')
  bot.chat('KadooBot is online! Type !help')

  const mcData = require('minecraft-data')(bot.version)
  const defaultMove = new Movements(bot, mcData)
  bot.pathfinder.setMovements(defaultMove)
})

bot.on('chat', (username, message) => {
  if (username === bot.username) return

  const args = message.trim().split(' ')
  const command = args[0].toLowerCase()

  if (command === '!help') {
    bot.chat('!follow | !come | !stop | !protect | !mine <block> | !say <text>')
  }

  if (command === '!follow') {
    const target = bot.players[username]?.entity
    if (!target) return bot.chat('I cannot see you')
    following = target
    bot.chat('Following you!')
  }

  if (command === '!come') {
    const target = bot.players[username]?.entity
    if (!target) return bot.chat('I cannot see you')
    bot.pathfinder.setGoal(new goals.GoalFollow(target, 1))
    bot.chat('Coming to you!')
  }

  if (command === '!stop') {
    following = null
    protecting = false
    bot.pathfinder.setGoal(null)
    bot.pvp.stop()
    bot.chat('Stopped.')
  }

  if (command === '!protect') {
    protecting = !protecting
    bot.chat(protecting ? 'Protect mode ON' : 'Protect mode OFF')
  }

  if (command === '!mine' && args[1]) {
    const blockName = args[1].toLowerCase()
    const blockType = bot.registry.blocksByName[blockName]
    if (!blockType) return bot.chat('Unknown block: ' + blockName)

    const block = bot.findBlock({
      matching: blockType.id,
      maxDistance: 64
    })

    if (!block) return bot.chat('Cannot find ' + blockName + ' nearby')

    bot.chat('Mining ' + blockName + '...')
    bot.collectBlock.collect(block)
      .then(() => bot.chat('Finished mining!'))
      .catch(() => bot.chat('Failed to mine'))
  }

  if (command === '!say') {
    bot.chat(args.slice(1).join(' '))
  }
})

bot.on('physicsTick', () => {
  if (following) {
    bot.pathfinder.setGoal(new goals.GoalFollow(following, 2), true)
  }

  if (protecting) {
    const mob = bot.nearestEntity(e =>
      e.type === 'mob' &&
      e.position.distanceTo(bot.entity.position) < 16 &&
      !['Armor Stand', 'Villager', 'Iron Golem'].includes(e.name)
    )
    if (mob) bot.pvp.attack(mob)
  }
})

bot.on('kicked', (reason) => {
  console.log('Kicked:', reason.toString())
  setTimeout(() => process.exit(1), 4000)
})

bot.on('end', () => {
  console.log('Disconnected. Restarting...')
  setTimeout(() => process.exit(1), 4000)
})

bot.on('error', err => console.log(err))
