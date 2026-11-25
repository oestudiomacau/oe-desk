const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { setImmediate: afterNavigation } = require('node:timers/promises');
const test = require('node:test');
const vm = require('node:vm');

const workspace = 'https://im.jinritemai.com/pc_seller_v2/main/workspace';
const sellerHome = 'https://fxg.jinritemai.com/ffa/mshop/homepage/index';

test('Feige login and reopened views return to the embedded workspace', async () => {
  const navigations = [];
  const contents = new EventEmitter();
  contents.getURL = () => navigations.at(-1);
  contents.loadURL = async url => { navigations.push(url); };
  contents.isDestroyed = contents.isLoadingMainFrame = () => false;
  contents.setBackgroundThrottling = () => {};
  contents.setWindowOpenHandler = handler => { contents.open = handler; };

  const source = readFileSync(join(__dirname, '../electron/main.cjs'), 'utf8');
  const context = {
    setImmediate, setTimeout, join, __dirname, URL,
    platformUrls: { douyin: workspace }, process: { env: {} },
    session: { fromPartition: () => ({}) },
    WebContentsView: class {
      constructor(options) { this.webContents = options.webContents || contents; }
      setBounds() {}
    },
    otherPlatformViews: new Map(), platformPageGroups: new Map(), otherPlatformView: null, otherPlatformId: '', otherStoreId: '',
    otherPlatformVisible: false, xianyuViewVisible: false, activePlatform: '', activeStoreId: '', currentBounds: null,
    sanitizeStoreId: id => id, mountOtherPlatformView({ reveal }) { context.otherPlatformVisible = reveal; }, emitState() {},
    listenerHostBounds: () => ({}), ensureListenerHostWindow: () => ({ contentView: { addChildView() {} } }),
    inspectDouyinStructure: async () => {}, injectFeigeBridge: async () => {}
  };
  const start = source.indexOf('function selectPlatformPage(');
  const open = vm.runInNewContext(source.slice(start, source.indexOf('// Goofish login', start)) + '\nopenOtherPlatform', context);
  await open('store', 'douyin');
  assert.equal(contents.getURL(), workspace);

  await contents.loadURL(sellerHome);
  contents.emit('did-finish-load');
  await afterNavigation();
  assert.equal(contents.getURL(), workspace);
  await contents.loadURL(sellerHome);
  contents.emit('did-finish-load');
  await afterNavigation();
  assert.equal(contents.getURL(), sellerHome, 'Repeated redirects must not loop');

  await open('store', 'douyin');
  assert.equal(contents.getURL(), workspace);
  const authenticatedWorkspace = workspace + '?selfId=123';
  assert.equal(contents.open({ url: authenticatedWorkspace }).action, 'deny');
  await afterNavigation();
  assert.equal(contents.getURL(), authenticatedWorkspace);
  assert.equal(contents.open({ url: 'file:///C:/Windows/test' }).action, 'deny');
  const child = new EventEmitter();
  child.isDestroyed = () => false;
  child.setWindowOpenHandler = () => {};
  const destination = 'https://fxg.jinritemai.com/login';
  const popup = contents.open({ url: destination });
  assert.equal(popup.action, 'allow');
  assert.equal(popup.createWindow({ webContents: child }), child);
  const group = context.platformPageGroups.get('douyin:store');
  assert.equal(group.selected, 1);
  assert.equal(context.otherPlatformView.webContents, child);
  assert.equal(contents.getURL(), authenticatedWorkspace, 'The chat page stays open when a link opens a tab');
  child.emit('destroyed');
  assert.equal(group.selected, 0);
  assert.equal(context.otherPlatformView.webContents, contents);
  group.manualNavigation = true;
  await contents.loadURL(sellerHome);
  contents.emit('did-finish-load');
  await afterNavigation();
  await open('store', 'douyin');
  assert.equal(contents.getURL(), sellerHome, 'Typing a seller page keeps that page open');
  assert.equal(vm.runInContext("operatorPlatformUrl('example.com:8080/help')", context), 'https://example.com:8080/help');
  assert.equal(vm.runInContext("operatorPlatformUrl('javascript:alert(1)')", context), null);
});
