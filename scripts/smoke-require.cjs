// Loads the production bundle with a stub `vscode` module to catch broken
// requires (e.g. native addons that esbuild inlined incorrectly) and
// module-evaluation errors. activate() is not called.
const Module = require('node:module');
const path = require('node:path');

class Stub {}
const enumLike = (...names) => Object.fromEntries(names.map((n, i) => [n, i]));
const vscodeStub = {
  TreeItem: Stub,
  Disposable: Stub,
  EventEmitter: Stub,
  ThemeIcon: Stub,
  ThemeColor: Stub,
  MarkdownString: Stub,
  Uri: Stub,
  Position: Stub,
  Range: Stub,
  Selection: Stub,
  RelativePattern: Stub,
  FileSystemError: class extends Error {},
  FileType: enumLike('Unknown', 'File', 'Directory', 'SymbolicLink'),
  FileChangeType: enumLike('Changed', 'Created', 'Deleted'),
  TreeItemCollapsibleState: enumLike('None', 'Collapsed', 'Expanded'),
  StatusBarAlignment: enumLike('Left', 'Right'),
  ProgressLocation: enumLike('SourceControl', 'Window', 'Notification'),
  ConfigurationTarget: enumLike('Global', 'Workspace', 'WorkspaceFolder'),
  TextEditorRevealType: enumLike('Default', 'InCenter'),
  window: {},
  workspace: {},
  commands: {},
  env: {},
};

const originalLoad = Module._load;
Module._load = function patchedLoad(request, ...rest) {
  if (request === 'vscode') return vscodeStub;
  return originalLoad.call(this, request, ...rest);
};

const bundle = path.resolve(__dirname, '..', 'dist', 'extension.js');
const mod = require(bundle);
if (typeof mod.activate !== 'function' || typeof mod.deactivate !== 'function') {
  console.error('smoke: bundle does not export activate/deactivate');
  process.exit(1);
}
console.log('smoke: bundle loads and exports activate/deactivate');
