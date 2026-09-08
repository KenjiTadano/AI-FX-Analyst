import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import ts from 'typescript';
let now = Date.now();
class Clock extends Date { static now() { return now; } }
function load(file, env = {}, fetch = async () => { throw Error('unexpected fetch'); }) {
  const exports = {};
  const source = ts.transpileModule(fs.readFileSync(file, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  vm.runInNewContext(source, { exports, require: name => name === 'server-only' ? {} : load(path.resolve(path.dirname(file), name + '.ts'), env, fetch), process: { env }, fetch, Date: Clock, URL, URLSearchParams, AbortSignal, console });
  return exports;
}
const { calculateIndicators: calc } = load('lib/market/indicators.ts');
const bars = Array.from({length: 200}, (_, i) => ({ time: new Date(now - (201-i)*14400000).toISOString(), open: 100+i, close: 100+i, high: 101+i, low: 99+i }));
const up = calc(bars);
assert.equal(up.sma20, 289.5); assert.equal(up.sma75, 262); assert.equal(up.sma200, 199.5);
assert.equal(up.rsi14, 100); assert(Math.abs(up.atr14 - 2) < 1e-10); assert.equal(up.recentHigh, 300); assert.equal(up.recentLow, 279); assert.equal(up.trend, 'bullish');
assert.equal(calc([...bars].reverse()).trend, 'bearish'); assert.equal(calc([...bars].reverse()).rsi14, 0);
assert.equal(calc(bars.map(c => ({...c, close: 100, open: 100, high: 100, low: 100}))).rsi14, 50);
assert.equal(calc([]).sma20, null); assert.equal(calc(bars.slice(0,14)).rsi14, null);
(async () => {
  assert.match((await load('lib/market/client.ts').getMarketData('USD/JPY')).price.error, /未設定/);
  let count = 0, fail = false;
  const fetch = async (url, options) => {
    count++;
    assert.equal(options.headers.Authorization, 'apikey test-only'); assert(!url.toString().includes('test-only'));
    if (fail) return {ok: true, status:200, json: async () => ({status:'error',code:429,message:'secret upstream'})};
    return {ok:true, status:200, json:async () => url.pathname === '/price' ? {price:'150.125'} : {values: [...bars].reverse().map(c => ({...c, datetime:c.time.slice(0,19).replace('T',' ')}))}};
  };
  const client = load('lib/market/client.ts', {TWELVE_DATA_API_KEY:'test-only'}, fetch);
  const [a,b] = await Promise.all([client.getMarketData('USD/JPY'), client.getMarketData('USD/JPY')]);
  assert.equal(count,4); assert.equal(a.price.data,150.125); assert.equal(b.timeframes['4h'].data.indicators.sma200,199.5);
  await client.getMarketData('USD/JPY'); assert.equal(count,4);
  now += 61000; fail = true;
  const stale = await client.getMarketData('USD/JPY'); assert.equal(stale.price.stale,true); assert.equal(stale.price.data,150.125); assert.match(stale.price.error,/利用上限/);
  assert.equal(stale.timeframes['1h'].error,null);
  const before = count; await client.getMarketData('GBP/JPY'); assert.equal(count,before);
  assert(!JSON.stringify(stale).includes('secret upstream'));
  console.log('PASS: SMA/RSI/ATR/trends, missing key, normalization, concurrent deduplication, TTL, partial failure, stale data, HTTP-200 rate limit, secret suppression');
})().catch(e => {console.error(e); process.exitCode=1;});
