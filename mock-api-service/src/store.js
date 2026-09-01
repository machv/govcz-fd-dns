const { createClient } = require('redis');
const fs = require('node:fs/promises');
const path = require('node:path');

const emptyState = () => ({
  domains: [],
  tokens: [],
  requests: [],
});

class MemoryStore {
  constructor(initialState = emptyState()) {
    this.state = structuredClone(initialState);
  }

  async read() {
    return structuredClone(this.state);
  }

  async update(mutator) {
    const next = structuredClone(this.state);
    const result = await mutator(next);
    this.state = next;
    return result;
  }

  async reset() {
    this.state = emptyState();
  }
}

class FileStore {
  constructor(filePath) {
    this.filePath = path.resolve(filePath);
    this.pending = Promise.resolve();
  }

  async read() {
    try {
      return JSON.parse(await fs.readFile(this.filePath, 'utf8'));
    } catch (error) {
      if (error.code === 'ENOENT') return emptyState();
      throw error;
    }
  }

  async update(mutator) {
    const operation = this.pending.then(async () => {
      const state = await this.read();
      const result = await mutator(state);
      await this.write(state);
      return result;
    });
    this.pending = operation.catch(() => {});
    return operation;
  }

  async reset() {
    const operation = this.pending.then(() => this.write(emptyState()));
    this.pending = operation.catch(() => {});
    return operation;
  }

  async write(state) {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    const temporaryPath = `${this.filePath}.${process.pid}.tmp`;
    await fs.writeFile(temporaryPath, JSON.stringify(state, null, 2));
    await fs.rename(temporaryPath, this.filePath);
  }
}

class RedisStore {
  constructor(client, key) {
    this.client = client;
    this.key = key;
  }

  async read() {
    const value = await this.client.get(this.key);
    return value ? JSON.parse(value) : emptyState();
  }

  async update(mutator) {
    // Azure Container Apps commonly runs a single mock replica. WATCH still
    // protects updates if the service is scaled out later.
    for (let attempt = 0; attempt < 10; attempt += 1) {
      try {
        await this.client.watch(this.key);
        const state = await this.read();
        const result = await mutator(state);
        const committed = await this.client.multi()
          .set(this.key, JSON.stringify(state))
          .exec();
        if (committed !== null) return result;
      } catch (error) {
        if (error.name !== 'WatchError') throw error;
      }
    }
    throw new Error('Redis state update conflicted too many times');
  }

  async reset() {
    await this.client.del(this.key);
  }
}

async function createStore(env = process.env) {
  if (!env.REDIS_URL) {
    const store = env.STATE_FILE ? new FileStore(env.STATE_FILE) : new MemoryStore();
    return { store, close: async () => {} };
  }

  const client = createClient({ url: env.REDIS_URL });
  client.on('error', (error) => console.error('Redis error:', error.message));
  await client.connect();
  return {
    store: new RedisStore(client, env.REDIS_KEY || 'dnsportal-mock:state'),
    close: () => client.quit(),
  };
}

module.exports = { FileStore, MemoryStore, createStore, emptyState };
