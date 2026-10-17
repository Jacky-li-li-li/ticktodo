import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { ModelRuntime } from '@earendil-works/pi-coding-agent'

const authPath = path.join(os.homedir(), '.pi', 'agent', 'auth.json')
const raw = JSON.parse(fs.readFileSync(authPath, 'utf8'))
const credentials = {
  read: async (p) => raw[p],
  list: async () => Object.entries(raw).map(([providerId, c]) => ({ providerId, ...c })),
  modify: async () => { throw new Error('read-only') },
  delete: async () => { throw new Error('read-only') },
}
const models = await ModelRuntime.create({ credentials, refreshOnCreate: false, allowModelNetwork: false })
const avail = await models.getAvailable()
console.log('available:', avail.length, avail.slice(0, 6).map((m) => `${m.provider}/${m.id}`).join(' | '))
const magpie = models.getModels('magpie')
console.log('magpie models:', magpie.length, magpie.slice(0, 3).map((m) => m.id).join(', '))
