import{r as e}from"./rolldown-runtime-XKyaHtl9.js";import{t}from"./react-dLPNCiqx.js";import{t as n}from"./jsx-runtime-LKYXHABd.js";import{S as r,b as i,l as a,y as o}from"./api-Vjc6maur.js";import{W as s,X as c,v as l,y as u}from"./utils-ClefVVC0.js";var d=e(t(),1),f={data:``},p=e=>{if(typeof window==`object`){let t=(e?e.querySelector(`#_goober`):window._goober)||Object.assign(document.createElement(`style`),{innerHTML:` `,id:`_goober`});return t.nonce=window.__nonce__,t.parentNode||(e||document.head).appendChild(t),t.firstChild}return e||f},m=/(?:([\u0080-\uFFFF\w-%@]+) *:? *([^{;]+?);|([^;}{]*?) *{)|(}\s*)/g,h=/\/\*[^]*?\*\/|  +/g,g=/\n+/g,_=(e,t)=>{let n=``,r=``,i=``;for(let a in e){let o=e[a];a[0]==`@`?a[1]==`i`?n=a+` `+o+`;`:r+=a[1]==`f`?_(o,a):a+`{`+_(o,a[1]==`k`?``:t)+`}`:typeof o==`object`?r+=_(o,t?t.replace(/([^,])+/g,e=>a.replace(/([^,]*:\S+\([^)]*\))|([^,])+/g,t=>/&/.test(t)?t.replace(/&/g,e):e?e+` `+t:t)):a):o!=null&&(a=/^--/.test(a)?a:a.replace(/[A-Z]/g,`-$&`).toLowerCase(),i+=_.p?_.p(a,o):a+`:`+o+`;`)}return n+(t&&i?t+`{`+i+`}`:i)+r},v={},y=e=>{if(typeof e==`object`){let t=``;for(let n in e)t+=n+y(e[n]);return t}return e},b=(e,t,n,r,i)=>{let a=y(e),o=v[a]||(v[a]=(e=>{let t=0,n=11;for(;t<e.length;)n=101*n+e.charCodeAt(t++)>>>0;return`go`+n})(a));if(!v[o]){let t=a===e?(e=>{let t,n,r=[{}];for(;t=m.exec(e.replace(h,``));)t[4]?r.shift():t[3]?(n=t[3].replace(g,` `).trim(),r.unshift(r[0][n]=r[0][n]||{})):r[0][t[1]]=t[2].replace(g,` `).trim();return r[0]})(e):e;v[o]=_(i?{[`@keyframes `+o]:t}:t,n?``:`.`+o)}let s=n&&v.g?v.g:null;return n&&(v.g=v[o]),((e,t,n,r)=>{r?t.data=t.data.replace(r,e):t.data.indexOf(e)===-1&&(t.data=n?e+t.data:t.data+e)})(v[o],t,r,s),o},x=(e,t,n)=>e.reduce((e,r,i)=>{let a=t[i];if(a&&a.call){let e=a(n),t=e&&e.props&&e.props.className||/^go/.test(e)&&e;a=t?`.`+t:e&&typeof e==`object`?e.props?``:_(e,``):!1===e?``:e}return e+r+(a??``)},``);function S(e){let t=this||{},n=e.call?e(t.p):e;return b(n.unshift?n.raw?x(n,[].slice.call(arguments,1),t.p):n.reduce((e,n)=>Object.assign(e,n&&n.call?n(t.p):n),{}):n,p(t.target),t.g,t.o,t.k)}var C,w,T;S.bind({g:1});var E=S.bind({k:1});function D(e,t,n,r){_.p=t,C=e,w=n,T=r}function O(e,t){let n=this||{};return function(){let r=arguments;function i(a,o){let s=Object.assign({},a),c=s.className||i.className;n.p=Object.assign({theme:w&&w()},s),n.o=/ *go\d+/.test(c),s.className=S.apply(n,r)+(c?` `+c:``),t&&(s.ref=o);let l=e;return e[0]&&(l=s.as||e,delete s.as),T&&l[0]&&T(s),C(l,s)}return t?t(i):i}}var k=e=>typeof e==`function`,A=(e,t)=>k(e)?e(t):e,j=(()=>{let e=0;return()=>(++e).toString()})(),M=(()=>{let e;return()=>{if(e===void 0&&typeof window<`u`){let t=matchMedia(`(prefers-reduced-motion: reduce)`);e=!t||t.matches}return e}})(),N=20,P=`default`,F=(e,t)=>{let{toastLimit:n}=e.settings;switch(t.type){case 0:return{...e,toasts:[t.toast,...e.toasts].slice(0,n)};case 1:return{...e,toasts:e.toasts.map(e=>e.id===t.toast.id?{...e,...t.toast}:e)};case 2:let{toast:r}=t;return F(e,{type:+!!e.toasts.find(e=>e.id===r.id),toast:r});case 3:let{toastId:i}=t;return{...e,toasts:e.toasts.map(e=>e.id===i||i===void 0?{...e,dismissed:!0,visible:!1}:e)};case 4:return t.toastId===void 0?{...e,toasts:[]}:{...e,toasts:e.toasts.filter(e=>e.id!==t.toastId)};case 5:return{...e,pausedAt:t.time};case 6:let a=t.time-(e.pausedAt||0);return{...e,pausedAt:void 0,toasts:e.toasts.map(e=>({...e,pauseDuration:e.pauseDuration+a}))}}},I=[],L={toasts:[],pausedAt:void 0,settings:{toastLimit:N}},R={},z=(e,t=P)=>{R[t]=F(R[t]||L,e),I.forEach(([e,n])=>{e===t&&n(R[t])})},B=e=>Object.keys(R).forEach(t=>z(e,t)),V=e=>Object.keys(R).find(t=>R[t].toasts.some(t=>t.id===e)),H=(e=P)=>t=>{z(t,e)},U={blank:4e3,error:4e3,success:2e3,loading:1/0,custom:4e3},W=(e={},t=P)=>{let[n,r]=(0,d.useState)(R[t]||L),i=(0,d.useRef)(R[t]);(0,d.useEffect)(()=>(i.current!==R[t]&&r(R[t]),I.push([t,r]),()=>{let e=I.findIndex(([e])=>e===t);e>-1&&I.splice(e,1)}),[t]);let a=n.toasts.map(t=>({...e,...e[t.type],...t,removeDelay:t.removeDelay||e[t.type]?.removeDelay||e?.removeDelay,duration:t.duration||e[t.type]?.duration||e?.duration||U[t.type],style:{...e.style,...e[t.type]?.style,...t.style}}));return{...n,toasts:a}},G=(e,t=`blank`,n)=>({createdAt:Date.now(),visible:!0,dismissed:!1,type:t,ariaProps:{role:`status`,"aria-live":`polite`},message:e,pauseDuration:0,...n,id:n?.id||j()}),K=e=>(t,n)=>{let r=G(t,e,n);return H(r.toasterId||V(r.id))({type:2,toast:r}),r.id},q=(e,t)=>K(`blank`)(e,t);q.error=K(`error`),q.success=K(`success`),q.loading=K(`loading`),q.custom=K(`custom`),q.dismiss=(e,t)=>{let n={type:3,toastId:e};t?H(t)(n):B(n)},q.dismissAll=e=>q.dismiss(void 0,e),q.remove=(e,t)=>{let n={type:4,toastId:e};t?H(t)(n):B(n)},q.removeAll=e=>q.remove(void 0,e),q.promise=(e,t,n)=>{let r=q.loading(t.loading,{...n,...n?.loading});return typeof e==`function`&&(e=e()),e.then(e=>{let i=t.success?A(t.success,e):void 0;return i?q.success(i,{id:r,...n,...n?.success}):q.dismiss(r),e}).catch(e=>{let i=t.error?A(t.error,e):void 0;i?q.error(i,{id:r,...n,...n?.error}):q.dismiss(r)}),e};var J=1e3,Y=(e,t=`default`)=>{let{toasts:n,pausedAt:r}=W(e,t),i=(0,d.useRef)(new Map).current,a=(0,d.useCallback)((e,t=J)=>{if(i.has(e))return;let n=setTimeout(()=>{i.delete(e),o({type:4,toastId:e})},t);i.set(e,n)},[]);(0,d.useEffect)(()=>{if(r)return;let e=Date.now(),i=n.map(n=>{if(n.duration===1/0)return;let r=(n.duration||0)+n.pauseDuration-(e-n.createdAt);if(r<0)n.visible&&q.dismiss(n.id);else return setTimeout(()=>q.dismiss(n.id,t),r)});return()=>{i.forEach(e=>e&&clearTimeout(e))}},[n,r,t]);let o=(0,d.useCallback)(H(t),[t]),s=(0,d.useCallback)(()=>{o({type:5,time:Date.now()})},[o]),c=(0,d.useCallback)((e,t)=>{o({type:1,toast:{id:e,height:t}})},[o]),l=(0,d.useCallback)(()=>{r&&o({type:6,time:Date.now()})},[r,o]),u=(0,d.useCallback)((e,t)=>{let{reverseOrder:r=!1,gutter:i=8,defaultPosition:a}=t||{},o=n.filter(t=>(t.position||a)===(e.position||a)&&t.height),s=o.findIndex(t=>t.id===e.id),c=o.filter((e,t)=>t<s&&e.visible).length;return o.filter(e=>e.visible).slice(...r?[c+1]:[0,c]).reduce((e,t)=>e+(t.height||0)+i,0)},[n]);return(0,d.useEffect)(()=>{n.forEach(e=>{if(e.dismissed)a(e.id,e.removeDelay);else{let t=i.get(e.id);t&&(clearTimeout(t),i.delete(e.id))}})},[n,a]),{toasts:n,handlers:{updateHeight:c,startPause:s,endPause:l,calculateOffset:u}}},ee=E`
from {
  transform: scale(0) rotate(45deg);
	opacity: 0;
}
to {
 transform: scale(1) rotate(45deg);
  opacity: 1;
}`,te=E`
from {
  transform: scale(0);
  opacity: 0;
}
to {
  transform: scale(1);
  opacity: 1;
}`,ne=E`
from {
  transform: scale(0) rotate(90deg);
	opacity: 0;
}
to {
  transform: scale(1) rotate(90deg);
	opacity: 1;
}`,re=O(`div`)`
  width: 20px;
  opacity: 0;
  height: 20px;
  border-radius: 10px;
  background: ${e=>e.primary||`#ff4b4b`};
  position: relative;
  transform: rotate(45deg);

  animation: ${ee} 0.3s cubic-bezier(0.175, 0.885, 0.32, 1.275)
    forwards;
  animation-delay: 100ms;

  &:after,
  &:before {
    content: '';
    animation: ${te} 0.15s ease-out forwards;
    animation-delay: 150ms;
    position: absolute;
    border-radius: 3px;
    opacity: 0;
    background: ${e=>e.secondary||`#fff`};
    bottom: 9px;
    left: 4px;
    height: 2px;
    width: 12px;
  }

  &:before {
    animation: ${ne} 0.15s ease-out forwards;
    animation-delay: 180ms;
    transform: rotate(90deg);
  }
`,ie=E`
  from {
    transform: rotate(0deg);
  }
  to {
    transform: rotate(360deg);
  }
`,ae=O(`div`)`
  width: 12px;
  height: 12px;
  box-sizing: border-box;
  border: 2px solid;
  border-radius: 100%;
  border-color: ${e=>e.secondary||`#e0e0e0`};
  border-right-color: ${e=>e.primary||`#616161`};
  animation: ${ie} 1s linear infinite;
`,oe=E`
from {
  transform: scale(0) rotate(45deg);
	opacity: 0;
}
to {
  transform: scale(1) rotate(45deg);
	opacity: 1;
}`,se=E`
0% {
	height: 0;
	width: 0;
	opacity: 0;
}
40% {
  height: 0;
	width: 6px;
	opacity: 1;
}
100% {
  opacity: 1;
  height: 10px;
}`,ce=O(`div`)`
  width: 20px;
  opacity: 0;
  height: 20px;
  border-radius: 10px;
  background: ${e=>e.primary||`#61d345`};
  position: relative;
  transform: rotate(45deg);

  animation: ${oe} 0.3s cubic-bezier(0.175, 0.885, 0.32, 1.275)
    forwards;
  animation-delay: 100ms;
  &:after {
    content: '';
    box-sizing: border-box;
    animation: ${se} 0.2s ease-out forwards;
    opacity: 0;
    animation-delay: 200ms;
    position: absolute;
    border-right: 2px solid;
    border-bottom: 2px solid;
    border-color: ${e=>e.secondary||`#fff`};
    bottom: 6px;
    left: 6px;
    height: 10px;
    width: 6px;
  }
`,le=O(`div`)`
  position: absolute;
`,ue=O(`div`)`
  position: relative;
  display: flex;
  justify-content: center;
  align-items: center;
  min-width: 20px;
  min-height: 20px;
`,de=E`
from {
  transform: scale(0.6);
  opacity: 0.4;
}
to {
  transform: scale(1);
  opacity: 1;
}`,fe=O(`div`)`
  position: relative;
  transform: scale(0.6);
  opacity: 0.4;
  min-width: 20px;
  animation: ${de} 0.3s 0.12s cubic-bezier(0.175, 0.885, 0.32, 1.275)
    forwards;
`,pe=({toast:e})=>{let{icon:t,type:n,iconTheme:r}=e;return t===void 0?n===`blank`?null:d.createElement(ue,null,d.createElement(ae,{...r}),n!==`loading`&&d.createElement(le,null,n===`error`?d.createElement(re,{...r}):d.createElement(ce,{...r}))):typeof t==`string`?d.createElement(fe,null,t):t},me=e=>`
0% {transform: translate3d(0,${e*-200}%,0) scale(.6); opacity:.5;}
100% {transform: translate3d(0,0,0) scale(1); opacity:1;}
`,he=e=>`
0% {transform: translate3d(0,0,-1px) scale(1); opacity:1;}
100% {transform: translate3d(0,${e*-150}%,-1px) scale(.6); opacity:0;}
`,ge=`0%{opacity:0;} 100%{opacity:1;}`,_e=`0%{opacity:1;} 100%{opacity:0;}`,ve=O(`div`)`
  display: flex;
  align-items: center;
  background: #fff;
  color: #363636;
  line-height: 1.3;
  will-change: transform;
  box-shadow: 0 3px 10px rgba(0, 0, 0, 0.1), 0 3px 3px rgba(0, 0, 0, 0.05);
  max-width: 350px;
  pointer-events: auto;
  padding: 8px 10px;
  border-radius: 8px;
`,ye=O(`div`)`
  display: flex;
  justify-content: center;
  margin: 4px 10px;
  color: inherit;
  flex: 1 1 auto;
  white-space: pre-line;
`,be=(e,t)=>{let n=e.includes(`top`)?1:-1,[r,i]=M()?[ge,_e]:[me(n),he(n)];return{animation:t?`${E(r)} 0.35s cubic-bezier(.21,1.02,.73,1) forwards`:`${E(i)} 0.4s forwards cubic-bezier(.06,.71,.55,1)`}},X=d.memo(({toast:e,position:t,style:n,children:r})=>{let i=e.height?be(e.position||t||`top-center`,e.visible):{opacity:0},a=d.createElement(pe,{toast:e}),o=d.createElement(ye,{...e.ariaProps},A(e.message,e));return d.createElement(ve,{className:e.className,style:{...i,...n,...e.style}},typeof r==`function`?r({icon:a,message:o}):d.createElement(d.Fragment,null,a,o))});D(d.createElement);var xe=({id:e,className:t,style:n,onHeightUpdate:r,children:i})=>{let a=d.useCallback(t=>{if(t){let n=()=>{let n=t.getBoundingClientRect().height;r(e,n)};n(),new MutationObserver(n).observe(t,{subtree:!0,childList:!0,characterData:!0})}},[e,r]);return d.createElement(`div`,{ref:a,className:t,style:n},i)},Se=(e,t)=>{let n=e.includes(`top`),r=n?{top:0}:{bottom:0},i=e.includes(`center`)?{justifyContent:`center`}:e.includes(`right`)?{justifyContent:`flex-end`}:{};return{left:0,right:0,display:`flex`,position:`absolute`,transition:M()?void 0:`all 230ms cubic-bezier(.21,1.02,.73,1)`,transform:`translateY(${t*(n?1:-1)}px)`,...r,...i}},Ce=S`
  z-index: 9999;
  > * {
    pointer-events: auto;
  }
`,Z=16,we=({reverseOrder:e,position:t=`top-center`,toastOptions:n,gutter:r,children:i,toasterId:a,containerStyle:o,containerClassName:s})=>{let{toasts:c,handlers:l}=Y(n,a);return d.createElement(`div`,{"data-rht-toaster":a||``,style:{position:`fixed`,zIndex:9999,top:Z,left:Z,right:Z,bottom:Z,pointerEvents:`none`,...o},className:s,onMouseEnter:l.startPause,onMouseLeave:l.endPause},c.map(n=>{let a=n.position||t,o=Se(a,l.calculateOffset(n,{reverseOrder:e,gutter:r,defaultPosition:t}));return d.createElement(xe,{id:n.id,key:n.id,onHeightUpdate:l.updateHeight,className:n.visible?Ce:``,style:o},n.type===`custom`?A(n.message,n):i?i(n):d.createElement(X,{toast:n,position:a}))}))},Te=q,Ee=n(),Q=(0,d.createContext)(null);function De({children:e}){let[t,n]=(0,d.useState)(null),[r,i]=(0,d.useState)(``),[a,o]=(0,d.useState)({}),s=(0,d.useMemo)(()=>r?JSON.parse(r):{},[r]),f=(0,d.useMemo)(()=>u(s,t||{}),[s,t]),p=(0,d.useCallback)(e=>n(t=>{let n=l(t||{});return e(n),n}),[]),m={config:t,setConfig:n,lastLoadedText:r,setLastLoadedText:i,loadedConfig:s,diff:f,updateConfig:p,updateField:(0,d.useCallback)((e,t)=>p(n=>c(n,e,t)),[p]),entityDrafts:a,setEntityDrafts:o};return(0,Ee.jsx)(Q.Provider,{value:m,children:e})}function $(){let e=(0,d.useContext)(Q);if(!e)throw Error(`ConfigDraftProvider is required`);return e}function Oe({t:e,dirty:t,pendingMappingJson:n,pendingConfigJson:c,pricingCatalogError:l,jsonError:u,setError:f,setMessage:p,loadRequestRef:m,applyLoadedConfig:h,loadSecondaryData:g,loadAll:_,loadCaddyStatusAction:v,closeHistory:y}){let{config:b,setConfig:x,lastLoadedText:S,entityDrafts:C}=$(),w=Object.keys(C).length>0,[T,E]=(0,d.useState)(null),[D,O]=(0,d.useState)(null),[k,A]=(0,d.useState)(``),[j,M]=(0,d.useState)(!1),[N,P]=(0,d.useState)(!1),F=(0,d.useRef)(0);function I(t){let n=s(t);return!n.length||window.confirm(`${e(`config.validation.confirm`,`The current configuration still has structural issues. Save anyway?`)}\n- ${n.slice(0,5).join(`
- `)}`)}async function L(t,i,a=!1){if(w)throw Error(e(`ui.unapplied`));if(n)throw Error(e(`channel.pendingJson`));if(c&&!a)throw Error(e(`advanced.pending`));R(await r(t),i)}function R(e,t){let n=e.config,r=m.current+1;m.current=r,h(n),g(r,{notifyOnError:!0}),z(e.apply,t)}function z(t,n){O(t||null);let r=[];t?.proxy?.ok===!1&&r.push(e(`messages.savedButProxyFailed`,`Configuration was saved, but proxy settings could not be fully applied: {error}`,{error:t.proxy.error})),t?.caddy?.ok===!1&&r.push(e(`messages.savedButCaddyFailed`,`Configuration was saved, but Caddy could not apply it: {error}`,{error:t.caddy.error||`Caddy reload failed`})),t?.persistence?.pendingDatabaseSync&&r.push(e(`messages.savedPendingDatabase`,`Configuration was saved locally; database synchronization is pending.`));for(let n of[t?.persistence?.cacheError,t?.persistence?.historyError])n&&r.push(e(`messages.savedButCopyFailed`,`Configuration was saved, but a cache/history copy failed: {error}`,{error:n.message}));f(r.join(` `)),p(r.length?``:n)}function B(){F.current++,E(null)}async function V(t){A(t);try{z((await o(t)).apply,e(`config.apply.retried`,`Configuration application retried.`)),await v()}catch(t){await W(t,e(`messages.saveFailed`,`Save failed.`))}finally{A(``)}}async function H(t){if(q()){M(!0);try{R(await i(t),e(`config.history.restored`,`Historical configuration restored as a new revision.`)),y(!0)}catch(t){if(t.payload?.code!==`CONFIG_REVISION_CONFLICT`)throw t;y(!1),await W(t,e(`messages.saveFailed`,`Save failed.`))}finally{M(!1)}}}async function U(){let t=++F.current;E({loading:!0,latest:null,error:``});try{let e=await a();if(t!==F.current)return;E({loading:!1,latest:e.config,activeRevision:e.activeRevision,error:``})}catch(n){if(t!==F.current)return;E({loading:!1,latest:null,error:n.message||e(`messages.loadFailed`,`Load failed.`)})}}async function W(e,t,n=b){e.payload?.code===`CONFIG_REVISION_CONFLICT`?(n!==b&&x(n),await U()):f(e.message||t)}async function G(){b&&(w?f(e(`ui.unapplied`)):n?f(e(`channel.pendingJson`)):c?f(e(`advanced.pending`)):l||u?f(e(`messages.invalidJson`,`JSON parse errors must be fixed before saving.`)):I(b)&&P(!0))}async function K(){P(!1),M(!0),f(``);try{await L(b,e(`messages.saved`,`Configuration saved. React admin now covers configuration, governance, and baseline operations.`))}catch(t){await W(t,e(`messages.saveFailed`,`Save failed.`))}finally{M(!1)}}function q(){return!t&&!w||window.confirm(e(`changes.discardConfirm`,`Discard all unsaved changes?`))}function J(){if(S&&q())try{h(JSON.parse(S)),p(e(`messages.discarded`,`Unsaved changes discarded.`))}catch{f(e(`messages.loadFailed`,`Load failed.`))}}async function Y(t=`load`,{discardPendingDatabaseSync:n=!1,expectedRevision:r}={}){(!n||window.confirm(e(`config.conflict.discardPending`,`Reloading may discard locally saved configuration awaiting database synchronization, as well as your draft. Continue?`)))&&q()&&await _(t,{discardPendingDatabaseSync:n,expectedRevision:r})}return{configConflict:T,lastApplication:D,applyingStage:k,saving:j,setSaving:M,showSaveModal:N,setShowSaveModal:P,confirmConfigIssues:I,persistConfig:L,reportApplication:z,closeConfigConflict:B,retryApplication:V,restoreHistoricalConfig:H,showConfigConflict:U,reportConfigSaveError:W,handleSave:G,proceedSave:K,handleDiscardChanges:J,handleReload:Y}}export{Te as a,we as i,Oe as n,$ as r,De as t};