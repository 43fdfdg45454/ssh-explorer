# SSH Explorer

Extensión para **VSCodium** (y VS Code) que monta directorios remotos por **SSH/SFTP** en el Explorador nativo: navega, abre, edita y guarda archivos remotos como si fueran locales. Funciona igual en el **VSCodium Flatpak** (`com.vscodium.codium`) y en la instalación nativa, y usa el **agente de credenciales del sistema** (`SSH_AUTH_SOCK`, `IdentityAgent`): ssh-agent, gnome-keyring, KeePassXC, 1Password, gpg-agent…

- Esquema `ssh://<conexión>/ruta` registrado como sistema de archivos: Explorador, editores y la mayoría de extensiones funcionan sin cambios.
- Los hosts de `~/.ssh/config` aparecen automáticamente (`HostName`, `User`, `Port`, `IdentityFile`, `IdentityAgent`, `ProxyJump`, `Include`).
- Reconexión automática con _backoff_, detección de cambios de red y operaciones que esperan a la reconexión: guardar durante un corte breve termina bien en vez de fallar.
- Verificación de claves de host contra `known_hosts` (entradas planas y _hashed_), diálogo _trust-on-first-use_ y rechazo de claves cambiadas.
- Escritura atómica (archivo temporal + `posix-rename@openssh.com`) que conserva los permisos del archivo.
- Contraseñas y _passphrases_ solo en el almacén de secretos del editor (en Flatpak, el _Secret Service_ del sistema), nunca en settings.

[English summary below](#english).

## Instalación

Descarga el `.vsix` de la [última release](https://github.com/43fdfdg45454/ssh-explorer/releases/latest) e instálalo:

```bash
# VSCodium nativo
codium --install-extension ssh-explorer-X.Y.Z.vsix

# VSCodium Flatpak
flatpak run com.vscodium.codium --install-extension ssh-explorer-X.Y.Z.vsix
```

También puedes usar _Extensions → … → Install from VSIX…_ dentro del editor.

## Uso

1. Abre la vista **SSH Explorer** en la barra de actividad. Verás los hosts de `~/.ssh/config` y las conexiones guardadas.
2. Haz clic en una conexión para **explorar** el directorio remoto (QuickPick): entra en carpetas, abre archivos o pulsa _Add this folder to the workspace_.
3. Con la carpeta en el workspace, el Explorador nativo muestra el árbol remoto: crear, renombrar, borrar, mover, copiar y editar funcionan como en local.

Acciones del menú contextual: Connect / Disconnect / Reconnect, Browse, Add Root Folder to Workspace, Add Remote Folder…, Open Remote File…, Edit / Remove Connection, Copy ssh:// URI. La barra de estado muestra el estado de las conexiones activas.

### Conexiones

Lo más sencillo es definir los hosts en `~/.ssh/config`; la extensión los lee (incluidos `Include` y `ProxyJump`). Para conexiones fuera del archivo usa **SSH Explorer: Add Connection…** o el setting `sshExplorer.connections`:

```jsonc
"sshExplorer.connections": [
  {
    "name": "web",                 // ssh://web/
    "host": "web.example.com",
    "user": "deploy",
    "port": 22,
    "root": "/var/www",            // vacío = directorio home remoto
    "identityFile": ["~/.ssh/id_ed25519"],
    "proxyJump": "bastion"         // alias de ~/.ssh/config o user@host:port
  }
]
```

### Autenticación

Orden de intentos: **agente SSH → ficheros de identidad → contraseña → keyboard-interactive**. Las credenciales que funcionaron se recuerdan en memoria, de modo que las reconexiones automáticas no vuelven a preguntar. `sshExplorer.auth.saveSecrets` controla si contraseñas y _passphrases_ se guardan en el almacén de secretos del editor.

### Agente de credenciales

El socket del agente se resuelve en este orden:

1. `agent` del perfil o `sshExplorer.agent.socket`
2. `IdentityAgent` de `~/.ssh/config` (`none` lo desactiva)
3. `$SSH_AUTH_SOCK`
4. Rutas conocidas (`sshExplorer.agent.probePaths`): `/run/flatpak/ssh-auth`, `$XDG_RUNTIME_DIR/ssh-auth`, `$XDG_RUNTIME_DIR/keyring/ssh`, `$XDG_RUNTIME_DIR/gcr/ssh`, `$XDG_RUNTIME_DIR/gnupg/S.gpg-agent.ssh`, `~/.1password/agent.sock`

**SSH Explorer: Diagnose SSH Agent** muestra cada candidato, si es un socket y cuántas identidades expone.

#### Flatpak

El manifest de `com.vscodium.codium` ya concede `--socket=ssh-auth` (el agente del host se reenvía al sandbox) y `--filesystem=host` (acceso a `~/.ssh`). Si el diagnóstico no encuentra ningún socket, concede el permiso y reinicia VSCodium:

```bash
flatpak override --user --socket=ssh-auth com.vscodium.codium
```

También puedes hacerlo con Flatseal (_Sockets → SSH authentication_). Para gpg-agent como agente SSH, apunta `IdentityAgent` a `${XDG_RUNTIME_DIR}/gnupg/S.gpg-agent.ssh`; para 1Password, a `~/.1password/agent.sock`.

### Reconexión y cambios de red

- Keepalives SSH cada 15 s (`sshExplorer.keepaliveIntervalSeconds`); tres fallos seguidos cierran el transporte y arrancan la reconexión.
- Reconexión inmediata al primer corte, después _backoff_ exponencial hasta `reconnect.maxDelaySeconds`, un máximo de `reconnect.maxAttempts` intentos y estado **Failed** con la acción _Retry_.
- Mientras se reconecta, las operaciones del Explorador esperan hasta `operationTimeoutSeconds` en lugar de fallar. Si se agota, el editor conserva el buffer sin guardar y puedes reintentar.
- Si cambian las interfaces de red (Wi‑Fi, VPN, suspensión), se sondea cada conexión y, si está muerta, se reconecta al instante.
- Si solo muere el canal SFTP, se reabre sobre la misma sesión SSH.

## Settings

| Setting                                                  | Default                  | Descripción                                                                  |
| -------------------------------------------------------- | ------------------------ | ---------------------------------------------------------------------------- |
| `sshExplorer.connections`                                | `[]`                     | Conexiones guardadas (ver arriba).                                           |
| `sshExplorer.sshConfig.enabled` / `.path`                | `true` / `~/.ssh/config` | Lectura de la configuración OpenSSH.                                         |
| `sshExplorer.knownHosts.path`                            | `~/.ssh/known_hosts`     | Archivo de claves de host conocidas.                                         |
| `sshExplorer.knownHosts.writeTo`                         | `userKnownHosts`         | Dónde guardar claves nuevas (`extension` = archivo privado de la extensión). |
| `sshExplorer.knownHosts.hashNewEntries`                  | `true`                   | Hashear los nombres de host al guardar.                                      |
| `sshExplorer.strictHostKeyChecking`                      | `ask`                    | `ask`, `accept-new` o `yes`.                                                 |
| `sshExplorer.agent.socket` / `.probePaths`               | —                        | Resolución del agente (ver arriba).                                          |
| `sshExplorer.auth.saveSecrets`                           | `ask`                    | `ask`, `always`, `never`.                                                    |
| `sshExplorer.keepaliveIntervalSeconds`                   | `15`                     | Keepalive SSH.                                                               |
| `sshExplorer.connectTimeoutSeconds`                      | `20`                     | Tiempo máximo del _handshake_.                                               |
| `sshExplorer.reconnect.maxAttempts` / `.maxDelaySeconds` | `10` / `30`              | Política de reconexión.                                                      |
| `sshExplorer.operationTimeoutSeconds`                    | `30`                     | Espera de una operación a la reconexión.                                     |
| `sshExplorer.maxConcurrentOps`                           | `8`                      | Operaciones SFTP simultáneas por conexión.                                   |
| `sshExplorer.atomicWrites`                               | `auto`                   | `auto`, `always`, `never`.                                                   |
| `sshExplorer.watch.pollIntervalSeconds`                  | `0`                      | Sondeo de cambios externos en archivos abiertos (0 = desactivado).           |
| `sshExplorer.networkChangeDetection`                     | `true`                   | Sondear conexiones al cambiar la red.                                        |

## Límites conocidos

- La búsqueda de texto y archivos del workspace no funciona sobre carpetas `ssh://` (requiere API propuesta de VS Code). Git y el terminal integrado tampoco operan sobre ellas.
- `ProxyCommand`, `CertificateFile` y bloques `Match` complejos de `ssh_config` no se soportan; `ProxyJump` sí.
- Claves FIDO (`sk-*`) solo a través del agente.
- Los cambios hechos en el servidor por otros procesos solo se detectan si activas el sondeo.

## Desarrollo

```bash
npm install          # instala dependencias y el hook pre-push (husky)
npm run watch        # bundle incremental; F5 abre el Extension Development Host
npm run verify       # lint + typecheck + prettier + tests + bundle + smoke (lo que corre el hook pre-push)
npm run package      # genera el .vsix
```

- Los tests de integración levantan un servidor SSH/SFTP en proceso (`ssh2.Server`) y un agente SSH falso por socket UNIX: no necesitan Docker ni sshd.
- Se trabaja siempre sobre `master`. El hook `pre-push` ejecuta `npm run verify`, de modo que a CI solo llegan cambios verificados (`git push --no-verify` lo omite en emergencias).
- **CI** (`.github/workflows/ci.yml`): un único job que calcula la versión con GitVersion, verifica, empaqueta y sube el `.vsix` como artefacto. **Release** (`release.yml`) se dispara al terminar CI en `master`, crea el tag `vX.Y.Z` y publica la GitHub Release con ese mismo `.vsix`. Si el tag ya existe (commits sin _bump_), no hace nada.
- Versionado con [GitVersion](https://gitversion.net) y Conventional Commits: `feat:` → minor, `fix|perf|refactor|build|chore:` → patch, `tipo!:` o `BREAKING CHANGE` → major, `docs|style|test|ci:` → sin release. Los cambios solo de documentación no disparan CI.

## English

SSH Explorer mounts remote directories over SSH/SFTP as `ssh://<connection>/path` so VSCodium's native Explorer and editors work on them unchanged. It runs identically in the VSCodium Flatpak and native builds, honours the system SSH agent socket (`SSH_AUTH_SOCK`, `IdentityAgent`, Flatpak's forwarded socket, gnome-keyring, gpg-agent, 1Password), reads hosts from `~/.ssh/config` (including `Include` and `ProxyJump`), verifies host keys against `known_hosts` with a trust-on-first-use dialog, writes files atomically preserving permissions, and reconnects automatically with exponential backoff while pending operations wait for the new channel. Install the `.vsix` from the [latest release](https://github.com/43fdfdg45454/ssh-explorer/releases/latest) with `codium --install-extension` or `flatpak run com.vscodium.codium --install-extension`. If no agent socket is reachable inside the sandbox, run `flatpak override --user --socket=ssh-auth com.vscodium.codium` and restart VSCodium. Known limits: no workspace search, Git or terminal over `ssh://` folders; no `ProxyCommand`.

## Licencia

[MIT](LICENSE)
