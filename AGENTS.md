# AGENTS.md

## Cursor Cloud specific instructions

### What this is
Mirae Messenger (`미래병원 메신저`) is an **Electron desktop app**: a hospital LAN messenger.
It is normally built/run on Windows, but in this cloud VM it runs on Linux in development
mode. Peers find each other over UDP `41234` and exchange messages/files over TCP `41235`,
and it also serves a mobile "transmission board" web page over HTTP on port `41236`.
Feature/usage details live in `docs/기능-설명서.md`; update mechanism in `docs/GitHub-업데이트.md`.

### Running the app (dev mode) in this VM
- A display is available at `DISPLAY=:1`. Chrome sandbox does not work in the container, so
  launch with `--no-sandbox`:
  ```
  DISPLAY=:1 ./node_modules/.bin/electron . --no-sandbox
  ```
  (`npm start` runs `electron .` but does not pass `--no-sandbox`, so prefer the command above.)
- There is **no hot reload** — after editing `main.js`/`index.html`/`preload.js` you must
  restart the Electron process for changes to take effect.
- Benign noise on startup: repeated `Failed to connect to the bus` (no D-Bus),
  `Exiting GPU process` (software GL), and `Invalid language code "ko-KR"` (spellchecker).

### CRITICAL gotcha: the app auto-updates from GitHub and overwrites your working tree
About 8s after launch (and every 10 min), `startUpdateChecker` fetches `version.json` from the
public GitHub repo `dragotigree/mirae-messenger` (`main`). If the remote version is greater than
the local `package.json` version, it **overwrites the source files in the working directory**
(`main.js`, `index.html`, `preload.js`, `lib/minimal-xlsx.js`, `package.json`, `version.json`,
`toast.html`, `toast-preload.js`) and **relaunches after ~30s**. On a feature branch that is
behind `main`, this silently clobbers the checked-out branch code and any uncommitted changes.

To develop/test branch code without this, point the in-app update source at a local folder
(no code change — it is a stored setting; a missing local `version.json` makes the update check
fail silently). The settings DB is created on first launch at
`~/.config/mirae-messenger/mirae_messenger.db`:
```
mkdir -p ~/.mirae-no-update
sqlite3 ~/.config/mirae-messenger/mirae_messenger.db \
  "UPDATE app_settings SET update_source_path='/home/ubuntu/.mirae-no-update' WHERE id=1;"
```
If a run already clobbered the tree, restore it with `git checkout -- <files>` and clear staged
updates with `rm -rf ~/.config/mirae-messenger/pending-update` before relaunching.

### Other side effect: stray `Z:\...` directory
~8s after launch the "Z-bridge" mirror runs and, on Linux, creates a literal directory named
`Z:\9.재활치료실(...)\물리치료실\messenger` in the current working directory. It is harmless and
untracked; remove it with `rm -rf 'Z:\'*` if it clutters `git status`. Do not commit it.

### Auth / demoing core functionality
- Default master credentials: id `admin`, password `admin1234` (seeded into `master_config`).
- A self-contained end-to-end path (no second peer needed): open the right-sidebar `📋 현황판`
  (ward schedule board) → `✍️ 작성자 로그인` (login with `admin`/`admin1234`) → `+ 빠른 등록` to
  register a schedule. Registered schedules persist to SQLite and are served at
  `http://localhost:41236/api/notices` and rendered at `http://localhost:41236/`.
- Full 1:1/channel chat requires multiple running instances/peers on the LAN, so it cannot be
  fully exercised from a single instance.

### Lint / test / build
- No test framework is configured. The closest "lint" is a syntax check of the large inline
  script in `index.html`: `node scripts/check-inline-script.mjs` (prints `SYNTAX OK`).
- The Windows packaging build (`build.ps1`, `npm run package`, `npm run installer`) requires
  PowerShell + `electron-packager` and targets `win32`; it is **not runnable** in this Linux VM.
