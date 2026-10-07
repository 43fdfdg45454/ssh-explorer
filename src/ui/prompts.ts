import type { Prompt } from 'ssh2';
import * as vscode from 'vscode';
import type { AuthPrompter } from '../ssh/auth';
import type { HostKeyPrompter, UnknownHostDecision } from '../ssh/hostVerifier';
import { hostPattern } from '../ssh/knownHosts';
import type { SudoPrompter } from '../ssh/sudo';
import type { ResolvedHost } from '../ssh/types';

function label(host: ResolvedHost): string {
  return `${host.user}@${hostPattern(host.hostName, host.port)}`;
}

/** Authentication prompts backed by VS Code input boxes. */
export class VsCodeAuthPrompter implements AuthPrompter {
  async askPassphrase(keyPath: string, host: ResolvedHost): Promise<string | undefined> {
    return vscode.window.showInputBox({
      title: `SSH Explorer: ${host.profile.name}`,
      prompt: `Passphrase for ${keyPath} (${label(host)})`,
      password: true,
      ignoreFocusOut: true,
    });
  }

  async askPassword(host: ResolvedHost, attempt: number): Promise<string | undefined> {
    return vscode.window.showInputBox({
      title: `SSH Explorer: ${host.profile.name}`,
      prompt: attempt > 1 ? `Password rejected. Password for ${label(host)}` : `Password for ${label(host)}`,
      password: true,
      ignoreFocusOut: true,
    });
  }

  async askKeyboardInteractive(
    host: ResolvedHost,
    name: string,
    instructions: string,
    prompts: Prompt[],
  ): Promise<string[] | undefined> {
    const answers: string[] = [];
    for (const p of prompts) {
      const answer = await vscode.window.showInputBox({
        title: `SSH Explorer: ${host.profile.name}${name ? ` – ${name}` : ''}`,
        prompt: [instructions, p.prompt].filter(Boolean).join(' '),
        password: !p.echo,
        ignoreFocusOut: true,
      });
      if (answer === undefined) return undefined;
      answers.push(answer);
    }
    return answers;
  }

  async askSaveSecret(kind: 'password' | 'passphrase', host: ResolvedHost): Promise<boolean> {
    const choice = await vscode.window.showInformationMessage(
      `Save the ${kind} for ${label(host)} in the secret storage of this editor?`,
      'Save',
      'Not now',
    );
    return choice === 'Save';
  }
}

/** Trust-on-first-use dialog. */
export class VsCodeHostKeyPrompter implements HostKeyPrompter {
  async confirmUnknownHost(info: {
    host: ResolvedHost;
    fingerprintSha256: string;
    keyType: string;
  }): Promise<UnknownHostDecision> {
    const where = hostPattern(info.host.hostName, info.host.port);
    const choice = await vscode.window.showWarningMessage(
      `The authenticity of host ${where} can't be established.`,
      {
        modal: true,
        detail: `${info.keyType} key fingerprint is ${info.fingerprintSha256}.\n\nVerify it against the server before continuing.`,
      },
      'Trust and save',
      'Trust once',
    );
    if (choice === 'Trust and save') return 'save';
    if (choice === 'Trust once') return 'once';
    return 'reject';
  }
}

/** Password prompt for sudo on the remote host. */
export class VsCodeSudoPrompter implements SudoPrompter {
  async askSudoPassword(host: ResolvedHost, attempt: number): Promise<string | undefined> {
    return vscode.window.showInputBox({
      title: `SSH Explorer: ${host.profile.name}`,
      prompt:
        attempt > 1
          ? `sudo rejected the password. [sudo] password for ${label(host)}`
          : `[sudo] password for ${label(host)} (needed to write files owned by root)`,
      password: true,
      ignoreFocusOut: true,
    });
  }

  async askSaveSudoPassword(host: ResolvedHost): Promise<boolean> {
    const choice = await vscode.window.showInformationMessage(
      `Save the sudo password for ${label(host)} in the secret storage of this editor?`,
      'Save',
      'Not now',
    );
    return choice === 'Save';
  }
}
