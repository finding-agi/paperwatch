// Shared top bar for the Paperwatch pages: logo, the Limit Intents (trigger) and Queue links, and the wallet button.
// Each page loads it with <script src="/site.js"></script> and names itself with <body data-page="queue|trigger">. The
// server fills in the two page URLs: /limits and /queue on paperwatch.app, where one server serves both.
//
// Wallets are found the way wagmi (and Papertrade's own app) finds them: EIP-6963 discovery, where each installed
// wallet announces itself with its name and icon. Rabby, MetaMask and Phantom are always listed (with install or
// open-in-app links when missing); any other wallet that announces itself is listed under them. Pages talk to it
// through window.paperwatchWallet and the 'paperwatch:wallet' event.
;(() => {
  const PAGES = [
    { id: 'trigger', label: 'Limit Intents', url: '__TRIGGER_URL__' },
    { id: 'queue', label: 'Queue', url: '__QUEUE_URL__' },
  ]
  const HYPEREVM = {
    chainId: '0x3e7', // 999
    chainName: 'HyperEVM',
    nativeCurrency: { name: 'HYPE', symbol: 'HYPE', decimals: 18 },
    rpcUrls: ['https://rpc.hyperliquid.xyz/evm'],
    blockExplorerUrls: ['https://hyperevmscan.io'],
  }
  const here = encodeURIComponent(location.href)
  const FEATURED = [
    { rdns: 'io.rabby', name: 'Rabby', color: '#7084ff', install: 'https://rabby.io' },
    { rdns: 'io.metamask', name: 'MetaMask', color: '#f6851b', install: 'https://metamask.io/download/', mobile: `https://metamask.app.link/dapp/${location.host}${location.pathname}` },
    { rdns: 'app.phantom', name: 'Phantom', color: '#ab9ff2', install: 'https://phantom.com/download', mobile: `https://phantom.app/ul/browse/${here}?ref=${encodeURIComponent(location.origin)}` },
  ]
  const isMobile = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent)

  const css = `
  @font-face { font-family: 'Manrope'; font-style: normal; font-display: swap; font-weight: 200 800; src: url('/assets/manrope.woff2') format('woff2'); }
  body { font-family: 'Manrope', system-ui, -apple-system, 'Segoe UI', sans-serif; }
  /* The bar sits on the brand brown: light-brown and white text, orange for the call to action. */
  .site-bar { position: sticky; top: 0; z-index: 50; background: #50413d; border-bottom: 1px solid rgba(225, 195, 187, 0.16); }
  .site-bar-in { max-width: 1600px; margin: 0 auto; height: 56px; padding: 0 16px; display: flex; align-items: center; gap: 22px; }
  .site-logo { display: flex; align-items: center; flex: none; }
  .site-logo img { height: 30px; width: auto; display: block; }
  .site-nav { display: flex; gap: 4px; flex: 1; min-width: 0; }
  .site-nav a { padding: 6px 12px; border-radius: 3px; color: rgba(225, 195, 187, 0.75); text-decoration: none; font-size: 15px; font-weight: 600; white-space: nowrap; }
  .site-nav a:hover { color: #fff; background: rgba(225, 195, 187, 0.08); }
  .site-nav a.on { color: #fff; background: rgba(225, 195, 187, 0.14); }
  .site-nav a.off { opacity: 0.45; pointer-events: none; }
  .site-stats { display: flex; gap: 18px; align-items: center; flex: none; }
  .site-stats:empty { display: none; }
  .site-stats .stat { display: flex; align-items: baseline; gap: 6px; font-size: 11px; font-weight: 700; letter-spacing: 0.08em; text-transform: uppercase; color: rgba(225, 195, 187, 0.7); white-space: nowrap; }
  .site-stats .stat b { font-size: 14px; letter-spacing: 0; color: #fff; font-weight: 600; font-variant-numeric: tabular-nums; }
  @media (max-width: 900px) { .site-stats { display: none; } }
  .site-wallet { flex: none; position: relative; }
  .site-wallet > button { font: inherit; font-size: 14px; font-weight: 700; padding: 8px 14px; border-radius: 3px; cursor: pointer; border: 1px solid #f04f24; background: #f04f24; color: #fff; display: flex; align-items: center; gap: 8px; }
  .site-wallet > button.connected { background: rgba(225, 195, 187, 0.12); color: #fff; border-color: rgba(225, 195, 187, 0.25); font-variant-numeric: tabular-nums; }
  .site-wallet > button img { width: 18px; height: 18px; border-radius: 4px; }
  .site-wallet .dot { width: 8px; height: 8px; border-radius: 50%; background: #f04f24; }
  .site-menu { position: absolute; right: 0; top: calc(100% + 6px); min-width: 220px; background: var(--raised, #fbf8f2); border: 1px solid var(--border, #e1d9c2); border-radius: 3px; padding: 6px; box-shadow: 0 8px 24px rgba(33, 27, 20, 0.12); display: grid; gap: 2px; }
  .site-menu[hidden] { display: none; }
  .site-menu .addr { padding: 8px 10px; color: var(--label, #736c5e); font-size: 12px; word-break: break-all; }
  .site-menu button { font: inherit; font-size: 14px; text-align: left; padding: 8px 10px; border: 0; border-radius: 3px; background: transparent; color: var(--ink-2, #322f27); cursor: pointer; }
  .site-menu button:hover { background: var(--page, #ece6d1); }
  .site-modal { position: fixed; inset: 0; z-index: 70; background: rgba(33, 27, 20, 0.35); display: flex; align-items: center; justify-content: center; padding: 16px; }
  .site-modal[hidden] { display: none; }
  .site-dialog { width: 100%; max-width: 380px; background: var(--surface, #f4eedb); border: 1px solid var(--border, #e1d9c2); border-radius: 4px; padding: 18px; display: grid; gap: 12px; box-shadow: 0 16px 40px rgba(33, 27, 20, 0.2); }
  .site-dialog h3 { margin: 0; font-size: 14px; font-weight: 700; letter-spacing: 0.08em; text-transform: uppercase; color: var(--ink, #211b14); display: flex; justify-content: space-between; align-items: center; }
  .site-dialog h3 button { font: inherit; font-size: 20px; line-height: 1; border: 0; background: transparent; color: var(--label, #736c5e); cursor: pointer; }
  .site-wallets { display: grid; gap: 6px; }
  .site-wallets a, .site-wallets button { font: inherit; font-size: 15px; font-weight: 600; display: flex; align-items: center; gap: 12px; padding: 10px 12px; border: 1px solid var(--border, #e1d9c2); border-radius: 3px; background: var(--raised, #fbf8f2); color: var(--ink, #211b14); cursor: pointer; text-decoration: none; text-align: left; }
  .site-wallets a:hover, .site-wallets button:hover { border-color: var(--line, #b5602c); }
  .site-wallets img, .site-wallets .ph { width: 28px; height: 28px; border-radius: 7px; flex: none; }
  .site-wallets .ph { display: grid; place-items: center; color: #fff; font-weight: 800; font-size: 14px; }
  .site-wallets .tag { margin-left: auto; font-size: 12px; font-weight: 600; color: var(--label, #736c5e); }
  .site-wallets .tag.ok { color: var(--green, #395e3d); }
  .site-wallets .missing { opacity: 0.75; }
  .site-dialog .fine { font-size: 12px; color: var(--label, #736c5e); }
  .site-toast { position: fixed; left: 50%; bottom: 20px; transform: translateX(-50%); z-index: 80; max-width: calc(100% - 32px); background: var(--ink, #211b14); color: #fff; padding: 10px 14px; border-radius: 3px; font-size: 14px; }
  @media (max-width: 560px) {
    .site-bar-in { gap: 10px; }
    .site-nav a { padding: 6px 8px; font-size: 14px; }
    .site-wallet > button { padding: 8px 10px; }
    .site-wallet .long { display: none; }
  }`

  const style = document.createElement('style')
  style.textContent = css
  document.head.appendChild(style)

  const page = document.body.dataset.page
  const bar = document.createElement('header')
  bar.className = 'site-bar'
  bar.innerHTML = `<div class="site-bar-in">
    <a class="site-logo" href="/" aria-label="Paperwatch"><img src="/assets/logo.png" alt="pw." width="58" height="30"></a>
    <nav class="site-nav">${PAGES.map((p) => {
      const href = p.id === page ? location.pathname : p.url
      return `<a href="${href || '#'}" class="${p.id === page ? 'on' : ''}${href ? '' : ' off'}"${href ? '' : ' title="Not deployed yet"'}>${p.label}</a>`
    }).join('')}</nav>
    <div class="site-stats" id="site-stats"></div>
    <div class="site-wallet"><button type="button" id="site-wallet-btn"></button>
      <div class="site-menu" id="site-wallet-menu" hidden><div class="addr" id="site-wallet-addr"></div><button type="button" id="site-wallet-copy">Copy address</button><button type="button" id="site-wallet-off">Disconnect</button></div>
    </div>
  </div>`
  document.body.prepend(bar)
  const modal = document.createElement('div')
  modal.className = 'site-modal'
  modal.hidden = true
  modal.innerHTML = `<div class="site-dialog" role="dialog" aria-modal="true" aria-label="Connect a wallet">
    <h3>Connect a wallet <button type="button" id="site-modal-x" aria-label="Close">×</button></h3>
    <div class="site-wallets" id="site-wallets"></div>
    <div class="fine">Connecting shares your address with this page. Nothing is signed or sent until you approve it in your wallet.</div>
  </div>`
  document.body.appendChild(modal)

  const $ = (id) => document.getElementById(id)
  const store = { get: (k) => { try { return localStorage.getItem(k) } catch { return null } }, set: (k, v) => { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v) } catch {} } }
  const toast = (msg) => {
    const t = document.createElement('div')
    t.className = 'site-toast'
    t.textContent = msg
    document.body.appendChild(t)
    setTimeout(() => t.remove(), 4000)
  }
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c])

  // ---- discovery ----------------------------------------------------------------------------------------------------
  const found = new Map() // rdns -> { info, provider }
  window.addEventListener('eip6963:announceProvider', (e) => {
    const { info, provider } = e.detail ?? {}
    // Announcements are untrusted page events: keep only a data: image icon, and escape names wherever shown.
    if (info?.rdns && provider) found.set(info.rdns, { info: { ...info, icon: /^data:image\//.test(info.icon ?? '') ? info.icon : '' }, provider })
    if (!modal.hidden) renderWallets()
  })
  window.dispatchEvent(new Event('eip6963:requestProvider'))
  // Wallets without EIP-6963 (some in-app browsers) still inject window.ethereum.
  const fallback = () => (found.size === 0 && window.ethereum ? { info: { rdns: 'injected', name: 'Browser wallet', icon: '' }, provider: window.ethereum } : null)

  let account = null
  let current = null // { info, provider }

  const renderButton = () => {
    const btn = $('site-wallet-btn')
    if (account) {
      btn.className = 'connected'
      btn.innerHTML = `${current?.info.icon ? `<img src="${esc(current.info.icon)}" alt="">` : '<span class="dot"></span>'}${account.slice(0, 6)}…${account.slice(-4)}`
      $('site-wallet-addr').textContent = account
    } else {
      btn.className = ''
      btn.innerHTML = '<span class="long">Connect </span>Wallet'
      $('site-wallet-menu').hidden = true
    }
  }
  const announce = () => {
    renderButton()
    window.dispatchEvent(new CustomEvent('paperwatch:wallet', { detail: { account } }))
  }

  function renderWallets() {
    const rows = FEATURED.map((w) => {
      const hit = found.get(w.rdns)
      if (hit) return `<button type="button" data-rdns="${w.rdns}"><img src="${esc(hit.info.icon)}" alt="">${esc(hit.info.name)}<span class="tag ok">Detected</span></button>`
      const href = isMobile && w.mobile ? w.mobile : w.install
      return `<a class="missing" href="${href}" target="_blank" rel="noopener"><span class="ph" style="background:${w.color}">${w.name[0]}</span>${w.name}<span class="tag">${isMobile && w.mobile ? 'Open in app' : 'Install'}</span></a>`
    })
    for (const [rdns, w] of found) {
      if (!FEATURED.some((f) => f.rdns === rdns)) rows.push(`<button type="button" data-rdns="${esc(rdns)}"><img src="${esc(w.info.icon)}" alt="">${esc(w.info.name)}<span class="tag ok">Detected</span></button>`)
    }
    const fb = fallback()
    if (fb) rows.push(`<button type="button" data-rdns="injected"><span class="ph" style="background:#736c5e">W</span>Browser wallet<span class="tag ok">Detected</span></button>`)
    $('site-wallets').innerHTML = rows.join('')
  }

  const ensureChain = async () => {
    const p = current?.provider
    if (!p) return
    try {
      await p.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: HYPEREVM.chainId }] })
    } catch (err) {
      if (err?.code === 4902 || /unrecognized|not added|unknown chain/i.test(err?.message ?? '')) await p.request({ method: 'wallet_addEthereumChain', params: [HYPEREVM] })
      else throw err
    }
  }

  const useWallet = async (rdns) => {
    const w = rdns === 'injected' ? fallback() : found.get(rdns)
    if (!w) return
    try {
      const [a] = await w.provider.request({ method: 'eth_requestAccounts' })
      if (!a) return
      current = w
      account = a.toLowerCase()
      store.set('paperwatch-wallet-rdns', rdns)
      modal.hidden = true
      listen(w.provider)
      announce()
      ensureChain().catch(() => toast('Switch your wallet to HyperEVM to trade.'))
    } catch (err) {
      if (err?.code !== 4001) toast(err?.message || 'Could not connect the wallet')
    }
  }

  let listening = null
  const listen = (provider) => {
    if (listening === provider) return
    listening = provider
    provider.on?.('accountsChanged', (list) => {
      if (current?.provider !== provider) return
      account = list[0]?.toLowerCase() ?? null
      if (!account) store.set('paperwatch-wallet-rdns', null)
      announce()
    })
  }

  const open = () => {
    window.dispatchEvent(new Event('eip6963:requestProvider'))
    renderWallets()
    modal.hidden = false
  }
  const disconnect = () => {
    account = null
    current = null
    store.set('paperwatch-wallet-rdns', null)
    announce()
  }

  $('site-wallet-btn').onclick = () => (account ? ($('site-wallet-menu').hidden = !$('site-wallet-menu').hidden) : open())
  $('site-wallets').onclick = (e) => {
    const b = e.target.closest('button[data-rdns]')
    if (b) useWallet(b.dataset.rdns)
  }
  $('site-modal-x').onclick = () => (modal.hidden = true)
  modal.onclick = (e) => { if (e.target === modal) modal.hidden = true }
  $('site-wallet-copy').onclick = () => { navigator.clipboard?.writeText(account).then(() => toast('Address copied')); $('site-wallet-menu').hidden = true }
  // Wallets can't be disconnected from a page; this forgets the connection here until you connect again.
  $('site-wallet-off').onclick = disconnect
  document.addEventListener('click', (e) => { if (!e.target.closest('.site-wallet')) $('site-wallet-menu').hidden = true })

  // Reconnect quietly to the wallet used last time (no popup), once wallets have had a moment to announce.
  const remembered = store.get('paperwatch-wallet-rdns')
  setTimeout(async () => {
    const w = remembered ? (remembered === 'injected' ? fallback() : found.get(remembered)) : null
    if (w) {
      try {
        const [a] = await w.provider.request({ method: 'eth_accounts' })
        if (a) {
          current = w
          account = a.toLowerCase()
          listen(w.provider)
        }
      } catch {}
    }
    announce()
  }, remembered ? 400 : 0)
  renderButton()

  // A page can show account figures in the bar, next to the wallet button: [{ label, value }], or null to clear.
  const setStats = (items) => {
    $('site-stats').innerHTML = (items ?? []).map((i) => `<span class="stat">${esc(i.label)}<b>${esc(i.value)}</b></span>`).join('')
  }

  window.paperwatchWallet = {
    setStats,
    get account() { return account },
    get provider() { return current?.provider ?? null },
    open,
    disconnect,
    ensureChain,
    toast,
  }
})()
