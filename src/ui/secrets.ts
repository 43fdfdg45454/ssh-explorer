import type * as vscode from 'vscode';
import type { SecretStore } from '../ssh/auth';

const INDEX_KEY = 'sshExplorer.secretKeys';

/** SecretStorage adapter that also tracks keys so they can be wiped on request. */
export class VsCodeSecretStore implements SecretStore {
  constructor(
    private readonly secrets: vscode.SecretStorage,
    private readonly state: vscode.Memento,
  ) {}

  get(key: string): Promise<string | undefined> {
    return Promise.resolve(this.secrets.get(key));
  }

  async store(key: string, value: string): Promise<void> {
    await this.secrets.store(key, value);
    const keys = new Set(this.state.get<string[]>(INDEX_KEY, []));
    keys.add(key);
    await this.state.update(INDEX_KEY, [...keys]);
  }

  async delete(key: string): Promise<void> {
    await this.secrets.delete(key);
    const keys = this.state.get<string[]>(INDEX_KEY, []).filter((k) => k !== key);
    await this.state.update(INDEX_KEY, keys);
  }

  async clearAll(): Promise<number> {
    const keys = this.state.get<string[]>(INDEX_KEY, []);
    for (const k of keys) await this.secrets.delete(k);
    await this.state.update(INDEX_KEY, []);
    return keys.length;
  }
}
