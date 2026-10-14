import { randomUUID } from 'node:crypto';
import { chromium } from 'playwright';

export class GameSessions {
  constructor({ appUrl = process.env.BEER_GAME_URL || 'http://127.0.0.1:8787', channel = process.env.BEER_GAME_BROWSER_CHANNEL, headless = process.env.BEER_GAME_HEADLESS !== 'false', maxSessions = 8 } = {}) {
    const url = new URL(appUrl);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('BEER_GAME_URL must be an HTTP(S) app URL without credentials.');
    url.hash = 'agent';
    this.url = url.href;
    this.channel = channel;
    this.headless = headless;
    this.maxSessions = maxSessions;
    this.sessions = new Map();
    this.browserPromise = null;
  }
  async browser() {
    if (!this.browserPromise) this.browserPromise = chromium.launch({ headless: this.headless, ...(this.channel ? { channel: this.channel } : {}) }).catch(error => {
      this.browserPromise = null;
      throw new Error(`Cannot launch the AI browser. Run npm run mcp:install-browser, or set BEER_GAME_BROWSER_CHANNEL=msedge (or chrome). ${error.message}`);
    });
    return this.browserPromise;
  }
  async create(command) {
    // Reserve the slot before asynchronous startup to enforce the limit on parallel calls.
    if (this.sessions.size >= this.maxSessions) throw new Error('Session limit reached. Close a game before creating another.');
    const sessionId = randomUUID();
    const session = { context: null, page: null, queue: Promise.resolve() };
    this.sessions.set(sessionId, session);
    try {
      const browser = await this.browser();
      session.context = await browser.newContext();
      session.page = await session.context.newPage();
      await session.page.goto(this.url, { waitUntil: 'domcontentloaded', timeout: 15000 });
      await session.page.waitForFunction(() => window.beerGameAgent?.version === 1, null, { timeout: 15000 });
      const state = await session.page.evaluate(input => window.beerGameAgent.command(input), command);
      return { sessionId, ...state };
    } catch (error) {
      await session.context?.close();
      this.sessions.delete(sessionId);
      throw new Error(`Could not create the game session. Check that the latest app is built and running at ${this.url}. ${error.message}`);
    }
  }
  get(sessionId) {
    const session = this.sessions.get(sessionId);
    if (!session?.page) throw new Error('Unknown or closed sessionId. Create or join a game first.');
    return session;
  }
  command(sessionId, command) {
    const session = this.get(sessionId);
    const run = session.queue.then(async () => ({ sessionId, ...await session.page.evaluate(input => window.beerGameAgent.command(input), command) }));
    session.queue = run.catch(() => {});
    return run;
  }
  async close(sessionId) {
    const session = this.get(sessionId);
    await session.queue;
    await session.page.evaluate(() => window.beerGameAgent.command({ type: 'leave' }));
    this.sessions.delete(sessionId);
    await session.context.close();
    return { sessionId, closed: true };
  }
  async dispose() {
    const browserPromise = this.browserPromise;
    this.sessions.clear();
    if (browserPromise) await (await browserPromise.catch(() => null))?.close();
  }
}
