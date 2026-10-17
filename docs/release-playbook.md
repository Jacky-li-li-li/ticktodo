# 发版全链路手册（macOS 桌面应用 / Electron 类）

面向 macOS 桌面应用（Electron / electron-builder / electron-updater 这一类）的完整发布链路。写法上只保留**跟具体项目无关的那部分**：机制在哪、为什么必须这么做、怎么自己验证一遍。

换项目时把 `<APP>`、`<OWNER>/<REPO>`、`<VERSION>` 换成自己的即可。凡是结论来自某个库的源码的，都写了源文件和函数名——库升级后照着再核一遍，别信记忆。

---

## 0. 先记住四条

1. **收口在 CI，别靠人记。** 版本号、tag、产物、cask 是四个要同时对齐的地方，只要有一处靠人记，迟早漏一次。
2. **签名 / 公证 / 更新只认打包产物，不认源码。** 任何"我在开发态试过"都不算数。能在真产物上验就别在开发态验。
3. **"能构建"不是"验过"。** 断言"某个文件真的进包了"，比断言"构建没报错"有用一个数量级。
4. **确定性失败不要重试。** 重试只是把每次诊断的延迟乘 N，还附送 N 份一模一样的报错。

---

## 1. 整条链路的顺序

顺序不是风格问题，每一步都卡在前一步的产物上。搞错顺序会得到一个"看起来成功了"的发布。

| # | 步骤 | 产出 | 为什么必须在这个位置 |
|---|------|------|----------------------|
| 1 | 改版本号 → 提交 → 打 tag → 推 | tag 指向的 commit | tag 是 CI 的唯一触发源；版本号必须与 tag 一致 |
| 2 | CI：typecheck / test | 绿灯 | 挡住"tag 打在执行不了代码的 commit 上" |
| 3 | CI：导入证书 → 构建 → 签名 → 公证 | `.app` / `.dmg` / `.zip` | 证书必须在构建前就位 |
| 4 | CI：质量闸（签名闸门 / 产物校验 / 启动冒烟） | 证据写进 job summary | 签名和公证之间原本没有任何检查，失败信息很难懂，闸门负责把证据摊开 |
| 5 | CI：上传 Release | Release + 资产 | |
| 6 | **手工：对齐 cask** | `Casks/<app>.rb` | cask 里的 sha256 只能从产物算，而产物是第 3 步才有的 → 它**必然**在第 5 步之后。这一步最容易漏，建议写成脚本 |
| 7 | **手工：用安装脚本/brew 真装一次** | 确认拿到的是新版本号 | |

一句话记忆：**版本 → 构建 → 签名 → 上传 → cask → 装机验证**。cask 在 Release 之后，是设计使然，不是疏忽。

---

## 2. 版本号与 tag

- 版本号有**多个**存放点（例如 monorepo 里根 package.json + 应用 package.json），它们和 tag 必须三者一致。
- **别用"记得改"来保证一致，让 CI 第一步就挡。** 做法：CI 只在 `refs/tags/v*` 上跑这一步，比较 `${GITHUB_REF_NAME#v}` 与各 package.json 的 version，不一致直接 `exit 1` 并 `::error::` 打出三个值。

这里有个反直觉的点：**tag 版本校验只对 tag 触发有效**。手动触发（`workflow_dispatch`）没有 tag 可比，那一步要 `if: startsWith(github.ref, 'refs/tags/v')` 跳掉，否则手动构建永远失败。手动构建的用途是"只出 Artifacts、不发 Release"，跟发版是两条路。

---

## 3. 构建：为什么必须同时出 zip 和 dmg

这是 macOS 上最容易被忽略的一条：

| 格式 | 给谁用 | 为什么不能省 |
|------|--------|--------------|
| `.dmg` | 人手动下载安装 | 用户熟悉 |
| `.zip` | **自动更新** | electron-updater 在 macOS 上只吃 zip。它下载 zip、解出 `.app`、交给 Squirrel 替换 |

**没有 zip，应用内更新直接不可用**（会报 `ZIP file not provided`）。反过来，只有 zip 没有 dmg 也能更新，只是用户不便。所以两个都要出。

多架构（arm64 + x64）时，`artifactName` 里**必须带 `${arch}`**，例如 `${productName}-${version}-${arch}.${ext}`。原因见 §5.3——更新器靠文件名里的架构串来挑包，名字里没有就挑不出来。

---

## 4. 签名与公证

### 4.1 证书和私钥可能不在同一个钥匙串

macOS 上很容易出现这种分布：

| 身份 | 证书在哪 | 私钥在哪 |
|------|----------|----------|
| Developer ID Application（分发用） | `/Library/Keychains/System.keychain` | login 钥匙串 |
| Apple Development（免费开发证书） | login 钥匙串 | login 钥匙串 |

于是 `security export -k login.keychain-db -t identities` **只会导出免费开发证书那一对**，看起来"导出成功了"，实际导出的是错的东西。

**先确认你的分布**，别假设：

```bash
security find-identity -v -p codesigning                    # 当前默认钥匙串
security find-certificate -a -c "Developer ID Application" /Library/Keychains/System.keychain | head -5
```

### 4.2 造 p12 的正确过程

```bash
# 1) 放开 login 里私钥的 ACL，否则第 2 步会报
#    "An invalid key was encountered" 并整体中断
security set-key-partition-list -S apple-tool:,apple:,codesign: -s -k <login 密码> -t private

# 2) 单独导出私钥
security export -k login.keychain-db -t privKeys -f pkcs12 -P <p12 密码> -o /tmp/keys.p12

# 3) 建临时钥匙串，把「Developer ID 证书 + 中间证书 + 上一步的私钥」拼进去
#    （中间证书是 Developer ID Certification Authority，从系统钥匙串拿）
# 4) 从临时钥匙串导出 identities
security export -k /tmp/build.keychain -t identities -f pkcs12 -P <p12 密码> -o dev-id.p12

# 5) 一定要验：导进一个全新隔离钥匙串，应该「恰好一个」Developer ID 身份
security find-identity -v -p codesigning /tmp/verify.keychain
```

第 5 步是自检的关键：**数目不对就是造错了**，不要等到 CI 上才知道。

### 4.3 为什么 p12 里必须只有 Developer ID 身份

`app-builder-lib` 在找不到 Developer ID 身份时会走一个兜底分支（`out/codeSign/macCodeSign.js`，找 `appleCertificatePrefixes` 那段逻辑）：**挑第一个非 Apple 证书**。而它的前缀白名单里没有 `Apple Development:` 这个字符串，于是免费开发证书会被当成"自定义证书"签掉整个包。签名阶段全绿，公证阶段才回一句：

```
The binary is not signed with a valid Developer ID certificate.
```

这句话完全指不到真正的原因。所以：

- 造 p12 时只放 Developer ID；
- 同时在构建配置里把身份钉死（electron-builder：`mac.identity: "Developer ID Application"`），不要靠自动发现。

### 4.4 CI 里怎么导入

```bash
security create-keychain -p "$KEYCHAIN_PASSWORD" "$KEYCHAIN_PATH"
security set-keychain-settings -lut 21600 "$KEYCHAIN_PATH"     # 免得构建中途自动上锁
security unlock-keychain -p "$KEYCHAIN_PASSWORD" "$KEYCHAIN_PATH"
echo "$CERT_B64" | base64 --decode > cert.p12
security import cert.p12 -P "$CERT_PASSWORD" -A -t cert -f pkcs12 -k "$KEYCHAIN_PATH"
security set-key-partition-list -S apple-tool:,apple: -k "$KEYCHAIN_PASSWORD" "$KEYCHAIN_PATH"
security list-keychain -d user -s "$KEYCHAIN_PATH"
```

`set-key-partition-list` 不能省：不放开 ACL，codesign 拿不到私钥，而 CI 里没人能点授权框，表现就是挂住。注意"挂住"有两种成因（另一种是时间戳服务，见 §8），表现一样都是 0% CPU。

### 4.5 没有交互终端时怎么诊断

CI 里你没法点弹窗、没法看 job summary 以外的东西。两个出口：

- **job summary**（`$GITHUB_STEP_SUMMARY`）：网页上直接能看，但**下载 CI 日志要鉴权**；
- **annotation**（`echo "::error title=<标题>::<内容>"`）：运行页和 commit 页都能直接看到，是 CI 之外唯一不需要凭据就能读的出口。把关键证据同时打到这两处。

签名闸门的思路：遍历 `.app` 里每个 Mach-O，读它的 Authority，区分：

| 结果 | 含义 |
|------|------|
| `developer-id` | 签对了 |
| `other:<authority>` | 被别的证书签了 ← 就是 §4.3 那个坑 |
| `never-touched` | 只有链接器签名（带 `linker-signed` 字样），说明 codesign 根本没走到这个文件 |
| `adhoc-resigned` | ad-hoc 但被显式签过（无证书时的正常结果） |
| `unsigned` | |

`never-touched` 和 `adhoc-resigned` 都是 ad-hoc，区别在于**签名那一步有没有跑到**——区分它们才能判断是"没证书"还是"有证书但漏了文件"。

闸门要 `if: always()` 跑，否则构建失败时它不跑，你就同时失去产物和证据。

---

## 5. 应用内更新（electron-updater）

### 5.1 `publish` 配置决定一切

构建配置里的 `publish` 是总开关。**没有它：**

- 不会往 `.app` 里写 `app-update.yml` → 应用运行时读不到更新源，直接报错；
- 不会生成 `latest-mac.yml` → 即使写了 feed，Release 上也没有它。

有了它，两者都会自动生成。

### 5.2 那两个文件什么时候、被谁写出来

| 文件 | 写在哪 | 谁写 | 条件 |
|------|--------|------|------|
| `app-update.yml` | `.app/Contents/Resources/` | `app-builder-lib` 的 `PublishManager`，挂在 `afterPack` 上 | **target 里有 `dmg` 或 `zip`** |
| `latest-mac.yml` | 构建输出目录 | `updateInfoBuilder.writeUpdateInfoFiles()` | 有 `publish` 配置；**与 `--publish never` 无关** |

两个坑都在这张表里：

- **用 `--dir`（或任何"只出 .app"的目标）调试时，永远不会有 `app-update.yml`。** 源码里明确 `if (!event.targets.some(it => it.name === "dmg" || it.name === "zip")) return;`。所以别用 `--dir` 的产物验证更新，会得到假阴性。
- **`--publish never` 不会阻止 `latest-mac.yml` 生成。** 它是给"我们要自己管发布"准备的，写文件那步不走 publish 分支。这也意味着不写 `--publish never` 的话，CI 环境可能被隐式触发去连 GitHub 发布。

顺带一个好消息：`app-update.yml` 是在 `emitAfterPack` 里写的，而签名（`signApp`）在它之后。所以不用担心"签完名又加文件把封条弄坏"。

### 5.3 多架构：合并成一份，且**不要信 `path`**

同一次构建出 arm64 + x64 时，`latest-mac.yml` **只有一份**，两个架构的产物都塞进 `files` 数组里。真实产物长这样：

```yaml
version: 1.2.3
files:
  - url: <APP>-1.2.3-x64.zip
  - url: <APP>-1.2.3-arm64.zip
  - url: <APP>-1.2.3-x64.dmg
  - url: <APP>-1.2.3-arm64.dmg
path: <APP>-1.2.3-x64.zip        # ← 只指向其中一条，别拿它当"该下哪个"
sha512: ...
releaseDate: ...
```

机制（`app-builder-lib/out/publish/updateInfoBuilder.js`）：

- `getArchPrefixForUpdateFile()` **只对 Linux 加架构前缀**，macOS 恒为 `latest-mac.yml` → 多架构合并进同一份；
- `writeUpdateInfoFiles()` 里按文件名做 key，把后来的 `info.files` **push 进已有那条** → 于是 `files` 里几种架构混在一起；
- `path` / `sha512` 是给老版本 electron-updater 的兼容字段，指向排序后的第一条（zip 优先，然后按架构枚举序）。**它不是"该下哪个"的答案。**

那"该下哪个"由谁决定？消费端的 `MacUpdater`（`electron-updater/out/MacUpdater.js`）：

- 先判断运行它的机器是不是 arm64；
- 然后 `files.filter(按文件名里有没有 "arm64")`；
- 再从中挑 `.zip`。

**所以 `artifactName` 里必须带 `${arch}`**——名字里没有 `arm64` 这个串，过滤就失效，arm64 用户可能拿到 x64 的包。这条是"名字即契约"，很容易在自定义 artifactName 时被破坏。

自己在真实产物上验一次的办法：本地起一个静态 HTTP 服务当 feed，把 yml 里的 `url` 换成一条**带 arm64 的假 zip**（sha512 对得上就行），看服务端日志里被请求的是哪个文件名。

### 5.4 `autoInstallOnAppQuit` 必须为 `true`

不是权衡，是硬要求。`MacUpdater.doDownloadUpdate()` 里：

```js
if (this.autoInstallOnAppQuit) {
  this.nativeUpdater.once("error", reject);
  this.nativeUpdater.checkForUpdates();       // ← 只有这里会把 zip 交给 Squirrel
} else {
  resolve([]);                                 // ← zip 下完了，但没人接手
}
```

关掉它的后果不是"少一个功能"，而是：**下载完成事件照常触发、"已下载"状态照常出现，但那个状态是假的**，`quitAndInstall()` 会一直等一个永远不会来的 `update-downloaded`，应用挂在那里。

`autoDownload` 可以关（关掉才能做成"用户点一下才下载"），`autoInstallOnAppQuit` 不能关。

怎么确认它真的走到 Squirrel 了：看应用日志里有没有类似

```
<sha>.zip requested by Squirrel.Mac, pipe .../pending/<APP>-<ver>-<arch>.zip
Download completed to: file:///.../ShipIt/update.XXXX/...
```

出现 `ShipIt` 就说明 Squirrel 真的接手了。

### 5.5 状态用带 tag 的联合，别用散落的布尔

`checking / available / downloading / ready / error` 本来就互斥。用 `{isChecking, hasUpdate, isDownloading, isReady}` 这种形状，允许出现"下载中"和"已下载"同时为真的状态，然后你会在 UI 里写一堆互相打架的 `if`。

用联合类型 + 一个 `status` 字段，`percent` 只挂在 `downloading` 上；主进程把库的回调收敛成这个联合再推给渲染层，渲染层只在**一个** `switch` 里把状态翻成文案和按钮。加状态时不会漏掉某个分支。

还有两个必须自己兜的状态：

- **开发态（未打包）没有 `app-update.yml`** → 库会直接抛错。要显式判 `app.isPackaged`，给一个 `unsupported` 状态让界面能如实显示"开发模式不检查更新"，而不是点了就报错。
- **`idle`**（还没检查过）跟 `up-to-date` 不是一回事，别合并。

### 5.6 依赖放哪：`dependencies` 不是 `devDependencies`

这条是**读源码得出的，没实测反向**。想在你的项目里确认：构建完看一眼输出目录里有没有 `github/latest-mac.json` 就知道了（文件会生成在构建输出目录下，多一层 `github/`）。

判断在 `updateInfoBuilder.computeIsisElectronUpdater1xCompatibility()`，条件是 `updaterVersion == null || semver.lt(updaterVersion, "4.0.0")`，而 `updaterVersion` 取自包自己的 `dependencies["electron-updater"]`（打包时读的 `metadata.dependencies` 就是你那份 package.json）：

- 放 `dependencies`：读到 `^6.x` → 判定"不需要 legacy 文件"；
- 放 `devDependencies`：读到 `null` → 按老版本处理，多写一个 `github/latest-mac.json`。

（另外从语义上说，被 main 进程 require 的东西本来就该在 `dependencies`。）

---

## 6. 分发通道

四条通道各自有独立的坑，别指望做通一条就都有了。

### 6.1 GitHub Release

- **feed 文件也是资产。** 上传步骤必须包含 `latest-mac.yml` 和 `*.blockmap`。
- `*.blockmap` 决定能不能**差分下载**；缺了不报错，只是每次都全量下载（一百多 MB），很难自己发现。
- **把 feed 文件当成"必须存在"的产物去断言。** 上传 action 对"某个 glob 没匹配到"默认是**静默跳过**的——`softprops/action-gh-release` 的 `fail_on_unmatched_files` 默认就是 `false`。真漏了 `latest-mac.yml`，Release 照样建成功，只是应用内更新从此全断，而且没人知道。把这个开关打开，或者上传前显式 `test -f`。
- 手动触发（`workflow_dispatch`）和 tag 触发要分成两条路：前者只出 Artifacts 不建 Release，并且在 CI 上**显式** `--publish never`（否则 CI 环境可能被隐式触发去连 GitHub 发布）。

### 6.2 一行安装脚本

```
curl -fsSL https://<host>/<user>/<repo>/main/scripts/install.sh | sh
```

要点：

- **版本号从 `releases/latest` 的跳转取**（`curl -fsSLI -o /dev/null -w '%{url_effective}' ...`，再 `sed 's#.*/tag/##'`）。不要解析 API 的 JSON：既受 API 速率限制，又要处理 schema 变化。
- **必须校验 sha256**：读 Release 上的 `SHA256SUMS.txt`，不匹配就中止。
- 流程：下载 → 校验 → `hdiutil attach -mountpoint` → 替换旧 app → `hdiutil detach` → `trap` 清临时目录。
- **脚本跟着 main 走，放仓库里，改完不用发版。** 用户拿到的一行地址永远指最新。
- 用 `set -eu`。
- **POSIX sh 坑**：`$VAR` 后面紧跟中文（多字节）时，sh 会把多字节字节当成变量名的一部分，报 unbound variable。**写成 `${VAR}`，后面接中文时永远加花括号。**
- 顺带一个"免费"的好处：`curl` 不写 `com.apple.quarantine`（浏览器会写），所以用一行脚本装的用户不会撞 Gatekeeper。

### 6.3 Homebrew cask

**tap 名字规则**：`brew tap user/repo` 一段式等价于 `user/homebrew-repo`。如果你的仓库就叫 `repo`（不是 `homebrew-repo`），一段式会去找一个不存在的仓库——必须两段式：

```bash
brew tap <user>/<repo> https://github.com/<user>/<repo>
brew install --cask <user>/<repo>/<cask>
```

**cask 的 sha256 只能从产物算**，所以 cask 更新必然在发版之后，而且是手工步骤。写个脚本替代手抄：

```bash
pnpm <script>:bump <version>     # 内部：fetch Release 上的 SHA256SUMS.txt → 重写整份 cask
```

只改 version 和 sha256，其余逐字节不动——这样 diff 里只有该变的东西，容易看出抄错。

**`url` 上不要写 `verified:`**——Homebrew 已废弃这个参数，用它会打 deprecation warning。默认行为就是拿下载地址的域名跟 `homepage` 比对。

**应用自己会更新时，必须声明 `auto_updates true`。** 机制在 `Library/Homebrew/cask/cask.rb` 的 `outdated_version`：

```ruby
return if installed_version == version          # 相等就不过时
if auto_updates && !greedy && !greedy_auto_updates
  return unless Homebrew::EnvConfig.upgrade_auto_updates_casks?
  return installed_version if auto_updates_bundle_outdated?
  return                                        # 默认：不算过时
end
installed_version
```

不声明的话，它比的是 **receipt 里记的版本**（不是 app 包里的版本）。于是应用一旦自更新：

- `brew list` 显示旧版本、`brew outdated` 一直报过时；
- 更麻烦的是反过来那次——应用已自更新到新版本、cask 还没 bump，`brew upgrade` 会把应用**降级**回去。

声明之后默认不再参与 brew 的版本比较；想让它按包内真实版本判断，用户可以自己开 `HOMEBREW_UPGRADE_AUTO_UPDATES_CASKS=1`。

---

## 7. CI 质量闸

两道，都不贵，都能挡住"签过了但打不开"：

**产物校验**

```bash
codesign --verify --strict --verbose=2 "<APP>.app"
xcrun stapler validate "<APP>.app"            # 配了证书才跑：确认公证票据真的装订了
test -f "<APP>.app/Contents/Resources/app.asar"          # 断言关键文件真的进包
test -f "<APP>.app/Contents/Resources/<extraResources 里某个东西>"
```

**启动冒烟**：真启动一次打包产物，抓主进程的一个已知日志（例如 `ready-to-show`），带超时轮询，抓不到就失败。

```bash
"$BIN" --no-sandbox > /tmp/smoke.log 2>&1 &
for i in $(seq 1 15); do
  grep -q "ready-to-show" /tmp/smoke.log && ok=1 && break
  kill -0 $PID 2>/dev/null || break
  sleep 2
done
```

为什么值得：`codesign --verify` 通过不代表应用能启动；构建成功不代表资源进包；公证成功不代表票据装订。这三件事只有真材料能证明。

---

## 8. 本地（开发机）环境坑

这些跟项目无关，但会吃掉你半天时间。

**macOS 的系统代理对命令行工具无效。** 系统设置里开着 HTTP/HTTPS/SOCKS 代理，但 `curl` / `brew` / `node` 都**只读环境变量**，不看系统代理。如果你的 DNS 恰好把目标域名解析到一条不通的线路，表现是**静默挂住**（curl 停在 SYN_SENT、brew 一动不动），而不是报错。

```bash
export HTTPS_PROXY=http://127.0.0.1:7897
export HTTP_PROXY=http://127.0.0.1:7897
export ALL_PROXY=socks5://127.0.0.1:7897
# node 的内置 fetch 还要额外这一句，否则照样 fetch failed
export NODE_USE_ENV_PROXY=1
```

两个附带事实：`git` 有时能直连成功，别被它误导（它自己的解析路径可能不一样）；代理出口 IP 是**共用**的，`api.github.com` 走代理容易撞 429，那个可以直连。

**iCloud / Desktop 下的目录会让 codesign 挂。** fileprovider 会往文件上挂扩展属性，`codesign` 报 `resource fork, Finder information, or similar detritus not allowed`。`xattr -cr` **清不掉**这些属性，实测只有

```bash
ditto --noextattr --norsrc <src>.app <dst>.app
```

才有用。所以：**别把构建产物放在 iCloud 同步目录里**，要放就用 ditto 挪到 `/tmp` 再操作。

**本地签 Developer ID 会卡在时间戳服务上。** 正式分发签名带 `--timestamp`，要连 Apple 的时间戳服务器；网络受限时 `codesign` 会停在 **0% CPU 静默挂着**（不报错，没有超时）。

实测对照：同一个 `.app`，`codesign --force --deep --sign -`（ad-hoc，不带 `--timestamp`）**秒过**；而走 Developer ID 那次 `codesign` 挂了 3 分钟以上、CPU 0%。所以本地出包不要试图走正式签名，用 `CSC_IDENTITY_AUTO_DISCOVERY=false` 跳过，签名交给 CI。同理，CI 也必须能连上 Apple 的时间戳服务，否则构建会**挂死**而不是失败——给构建步骤配 job 级超时。

**无证书时给 ad-hoc 签名。** 用 `afterPack` 钩子做 `codesign --force --deep --sign -`，否则 Apple Silicon 上的用户下载后会看到"已损坏，无法打开"。有正式证书时跳过，交给构建工具签。

---

## 9. 发版检查清单

发之前：

- [ ] 版本号在**所有**存放点都改了（monorepo 常见两个）
- [ ] 提交信息用 `chore(release): 版本推到 X.Y.Z`，先把版本提交掉，**再**打 tag
- [ ] CI 的 tag 一致性校验还在，并且只在 tag 触发时跑

发之后（等 CI 全绿）：

- [ ] Release 资产里有 `*.dmg`、`*.zip`、`*.blockmap`、`latest-mac.yml`、`SHA256SUMS.txt`
- [ ] `latest-mac.yml` 里的 `version` 是本版，且 `files` 里**每个架构都有 `.zip` 条目**
- [ ] `stapler validate` 通过
- [ ] 跑 cask 对齐脚本，diff 里只有 version 和 sha256
- [ ] push cask 之后**更新本机 tap**（`git -C <tap 目录> pull`），否则本机装的还是旧 cask
- [ ] 用一行脚本或 brew 真装一次，确认版本号是新的
- [ ] 若应用支持自更新：留着上一个版本装在机器上，等下一版发布时点一次更新，看它真的换包了

---

## 10. 怎么算"验过"

这是整份文档里最值钱的一节。

| 说法 | 是否算验过 |
|------|-----------|
| 类型检查 / 单测过了 | 只证明能编译、局部逻辑对 |
| `vite build` 过了 | 只证明能打包 |
| 打包产物起来了 | 算，但只覆盖启动路径 |
| **在打包产物上走到目标代码分支** | 算 |
| **用真实数据 / 真实远端 feed 走一遍** | 算，最理想 |
| 造假输入走一遍 | **只证明一半**，要标明哪一半 |

三条经验：

1. **验证要落在"匹配的 surface"上。** 修的是打包态的问题，就别在开发态验；修的是 UI 可见的问题，就去看 UI（渲染进程真的调一遍 IPC），别只看主进程日志。
2. **能自己造条件造条件，但要说清造了什么。** 例如自更新的"下载 → 已完成"两段，可以起个本地 HTTP 服务当 feed、造一个 sha512 对得上的假包，这一段是真实执行的；但"安装替换"那一段永远验不了（Squirrel 会拒掉假包）——**那就明说它没验**，不要含糊过去。
3. **有些结论只能等下一个版本才能验。** 例如"应用能自己升级"需要一个真实的、更新的 Release 存在。这时候的诚实写法是：把已经验到的部分和没验到的部分分开写，并给出下一次发版时可以顺带验掉的清单。
