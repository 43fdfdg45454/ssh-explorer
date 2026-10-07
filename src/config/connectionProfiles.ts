import { PROFILE_NAME_PATTERN } from '../constants';
import type { ProfileSource } from '../ssh/connectionManager';
import type { SshConfigLoader } from '../ssh/sshConfigLoader';
import type { ConnectionProfile } from '../ssh/types';
import { Logger } from '../util/logger';
import type { Settings } from './settings';

const log = new Logger('profiles');

/** Merges saved connections (settings) with Host aliases from ~/.ssh/config. */
export class SettingsAndSshConfigProfiles implements ProfileSource {
  constructor(
    private readonly settings: Settings,
    private readonly sshConfig: SshConfigLoader,
  ) {}

  async loadProfiles(): Promise<ConnectionProfile[]> {
    const byName = new Map<string, ConnectionProfile>();
    for (const p of this.settings.connections()) byName.set(p.name.toLowerCase(), p);

    if (this.settings.sshConfigEnabled()) {
      try {
        await this.sshConfig.load();
        for (const alias of this.sshConfig.listHosts()) {
          if (!PROFILE_NAME_PATTERN.test(alias)) {
            log.debug(`Skipping ssh_config host "${alias}": name not usable as a URI authority`);
            continue;
          }
          const key = alias.toLowerCase();
          if (byName.has(key)) continue;
          byName.set(key, { name: alias, host: alias, source: 'sshConfig' });
        }
      } catch (err) {
        log.warn(`Could not read ssh_config: ${String(err)}`);
      }
    }
    return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
  }
}
