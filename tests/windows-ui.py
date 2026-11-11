"""Inspect the actual WebView2 UI and exercise the desktop shortcut on CI."""
import urllib.request,json,time,base64,pathlib,subprocess
import websocket

for attempt in range(30):
    try:
        targets=json.load(urllib.request.urlopen('http://127.0.0.1:9222/json'))
        target=next(x for x in targets if x.get('type')=='page')
        break
    except Exception:
        time.sleep(1)
else: raise RuntimeError('No WebView2 debugging target')
ws=websocket.create_connection(target['webSocketDebuggerUrl'],suppress_origin=True)
seq=0

def call(method,params=None):
    global seq
    seq+=1
    ws.send(json.dumps({'id':seq,'method':method,'params':params or {}}))
    while True:
        r=json.loads(ws.recv())
        if r.get('id')==seq:
            if 'error' in r: raise RuntimeError(r['error'])
            return r.get('result',{})

def evaluate(code):
    r=call('Runtime.evaluate',{'expression':code,'awaitPromise':True,'returnByValue':True})
    if 'exceptionDetails' in r: raise RuntimeError(r['exceptionDetails'])
    return r.get('result',{}).get('value')

time.sleep(2)
assert evaluate("typeof window.__TAURI__==='object'"), 'Tauri bridge missing'
evaluate('document.fonts.ready.then(()=>true)')
font=evaluate("({loaded:document.fonts.check('14px Inter'),faces:[...document.fonts].map(f=>({family:f.family,status:f.status}))})")
print('ACTUAL_WINDOWS_FONT',json.dumps(font))
assert any(f['family']=='Inter' and f['status']=='loaded' for f in font['faces'])
evaluate("document.querySelector('[data-settings]').click()")
time.sleep(1)
assert evaluate("!!document.querySelector('[role=dialog]')"),'Settings missing'
# Exercise saved corner setting through the real UI.
evaluate("(()=>{const e=document.querySelector('[data-pref=rounding]');e.value=12;e.dispatchEvent(new Event('input',{bubbles:true}));})()")
time.sleep(1)
print('SAVED_CORNERS',evaluate("JSON.parse(localStorage.getItem('island.prefs')).rounding"))
assert evaluate("JSON.parse(localStorage.getItem('island.prefs')).rounding")==12
shot=call('Page.captureScreenshot',{'format':'png'})
pathlib.Path('windows-settings.png').write_bytes(base64.b64decode(shot['data']))
# Use the actual Close control then Windows desktop Ctrl+I, not a mocked invoke.
evaluate("document.querySelector('[data-hide]').click()")
time.sleep(1)
print('AFTER_CLOSE',evaluate('document.visibilityState'))
subprocess.run(['powershell','-NoProfile','-Command',"(New-Object -ComObject Shell.Application).MinimizeAll(); Start-Sleep -Milliseconds 700; (New-Object -ComObject WScript.Shell).SendKeys('^i')"],check=True)
time.sleep(2)
print('SHORTCUT_STATUS',evaluate("window.__TAURI__.core.invoke('shortcut_status')"))
print('AFTER_CTRL_I',evaluate('document.visibilityState'))
# Visibility can be affected by CI's non-interactive shell: report, never falsely pass it.
report={'font':font,'after_ctrl_i':evaluate('document.visibilityState'),'shortcut':evaluate("window.__TAURI__.core.invoke('shortcut_status')")}
pathlib.Path('windows-ui-report.json').write_text(json.dumps(report,indent=2))
ws.close()
