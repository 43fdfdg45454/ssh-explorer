// Minimal stand-in for the `vscode` module so that pure logic can be unit-tested
// outside the extension host. Only the surface used by the code under test exists.
export class Disposable {
  constructor(private readonly fn?: () => void) {}
  dispose(): void {
    this.fn?.();
  }
  static from(...items: { dispose(): unknown }[]): Disposable {
    return new Disposable(() => items.forEach((i) => i.dispose()));
  }
}

export class EventEmitter<T> {
  private listeners = new Set<(e: T) => unknown>();
  readonly event = (listener: (e: T) => unknown): Disposable => {
    this.listeners.add(listener);
    return new Disposable(() => this.listeners.delete(listener));
  };
  fire(data: T): void {
    for (const l of [...this.listeners]) l(data);
  }
  dispose(): void {
    this.listeners.clear();
  }
}

export enum FileType {
  Unknown = 0,
  File = 1,
  Directory = 2,
  SymbolicLink = 64,
}

export enum FileChangeType {
  Changed = 1,
  Created = 2,
  Deleted = 3,
}

export enum FilePermission {
  Readonly = 1,
}

function describe(uri: unknown): string {
  if (uri === undefined || uri === null) return '';
  if (typeof uri === 'string') return uri;
  if (uri instanceof Uri) return uri.toString();
  return JSON.stringify(uri);
}

export class FileSystemError extends Error {
  constructor(
    message: string,
    public readonly code: string,
  ) {
    super(message);
    this.name = 'FileSystemError';
  }
  static FileNotFound(uri?: unknown): FileSystemError {
    return new FileSystemError(`File not found: ${describe(uri)}`, 'FileNotFound');
  }
  static FileExists(uri?: unknown): FileSystemError {
    return new FileSystemError(`File exists: ${describe(uri)}`, 'FileExists');
  }
  static FileNotADirectory(uri?: unknown): FileSystemError {
    return new FileSystemError(`Not a directory: ${describe(uri)}`, 'FileNotADirectory');
  }
  static FileIsADirectory(uri?: unknown): FileSystemError {
    return new FileSystemError(`Is a directory: ${describe(uri)}`, 'FileIsADirectory');
  }
  static NoPermissions(uri?: unknown): FileSystemError {
    return new FileSystemError(`No permissions: ${describe(uri)}`, 'NoPermissions');
  }
  static Unavailable(uri?: unknown): FileSystemError {
    return new FileSystemError(`Unavailable: ${describe(uri)}`, 'Unavailable');
  }
}

export class Uri {
  private constructor(
    readonly scheme: string,
    readonly authority: string,
    readonly path: string,
    readonly query = '',
    readonly fragment = '',
  ) {}
  static parse(value: string): Uri {
    const m = /^([a-zA-Z][a-zA-Z0-9+.-]*):\/\/([^/?#]*)([^?#]*)(?:\?([^#]*))?(?:#(.*))?$/.exec(value);
    if (!m) throw new Error(`Invalid URI: ${value}`);
    return new Uri(m[1]!, m[2]!, decodeURIComponent(m[3] ?? ''), m[4] ?? '', m[5] ?? '');
  }
  static from(c: {
    scheme: string;
    authority?: string;
    path?: string;
    query?: string;
    fragment?: string;
  }): Uri {
    return new Uri(c.scheme, c.authority ?? '', c.path ?? '', c.query ?? '', c.fragment ?? '');
  }
  static file(p: string): Uri {
    return new Uri('file', '', p);
  }
  with(change: {
    scheme?: string;
    authority?: string;
    path?: string;
    query?: string;
    fragment?: string;
  }): Uri {
    return new Uri(
      change.scheme ?? this.scheme,
      change.authority ?? this.authority,
      change.path ?? this.path,
      change.query ?? this.query,
      change.fragment ?? this.fragment,
    );
  }
  toString(): string {
    return `${this.scheme}://${this.authority}${encodeURI(this.path)}`;
  }
  get fsPath(): string {
    return this.path;
  }
}

export class ThemeIcon {
  constructor(
    readonly id: string,
    readonly color?: unknown,
  ) {}
}
export class ThemeColor {
  constructor(readonly id: string) {}
}
export class TreeItem {
  label?: string | { label: string };
  description?: string;
  tooltip?: string;
  contextValue?: string;
  iconPath?: unknown;
  command?: unknown;
  collapsibleState?: number;
  constructor(label: string, collapsibleState?: number) {
    this.label = label;
    this.collapsibleState = collapsibleState;
  }
}
export enum TreeItemCollapsibleState {
  None = 0,
  Collapsed = 1,
  Expanded = 2,
}
export class MarkdownString {
  value = '';
  constructor(value = '') {
    this.value = value;
  }
  appendMarkdown(v: string): this {
    this.value += v;
    return this;
  }
}
export enum StatusBarAlignment {
  Left = 1,
  Right = 2,
}
export enum LogLevel {
  Off = 0,
  Trace = 1,
  Debug = 2,
  Info = 3,
  Warning = 4,
  Error = 5,
}

const noop = () => undefined;
export const window = {
  showInformationMessage: async () => undefined,
  showWarningMessage: async () => undefined,
  showErrorMessage: async () => undefined,
  showInputBox: async () => undefined,
  showQuickPick: async () => undefined,
  createOutputChannel: () => ({
    appendLine: noop,
    append: noop,
    trace: noop,
    debug: noop,
    info: noop,
    warn: noop,
    error: noop,
    show: noop,
    dispose: noop,
    logLevel: 3,
    onDidChangeLogLevel: () => new Disposable(),
  }),
  createStatusBarItem: () => ({ show: noop, hide: noop, dispose: noop }),
  createTreeView: () => ({ dispose: noop, onDidChangeVisibility: () => new Disposable() }),
};
export const workspace = {
  getConfiguration: () => ({ get: (_k: string, d?: unknown) => d, update: async () => undefined }),
  onDidChangeConfiguration: () => new Disposable(),
  workspaceFolders: undefined as unknown[] | undefined,
  updateWorkspaceFolders: () => true,
  fs: {},
};
export const commands = {
  registerCommand: () => new Disposable(),
  executeCommand: async () => undefined,
};
export const env = { clipboard: { writeText: async () => undefined }, openExternal: async () => true };
