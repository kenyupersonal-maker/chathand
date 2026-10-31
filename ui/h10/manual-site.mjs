import {uiText} from '../local-text.mjs';

// Editable, localized teaching diagrams from the approved manual Site frames.
// These contain example text only. Connection data is never passed to them.
const esc=value=>String(value??'').replace(/[&<>"']/g,ch=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));
const t=key=>esc(uiText(`ui.h10.manual.${key}`));
export const siteAsset=name=>new URL(`./assets/site-manual/${name}.svg`,import.meta.url).href;
const icon=name=>`<img src="${siteAsset(name)}" alt="" draggable="false">`;
const titlebar=title=>`<div class="h10-site-diagram-title"><strong>${title}</strong><small>${t('illustration')}</small></div>`;
const plate=(key,body)=>`<figure class="h10-site-plate" data-tutorial="${key}" role="img" aria-label="${t(`${key}Alt`)}"><div class="h10-site-example" aria-hidden="true">${body}</div></figure>`;

export const manualSiteView=vm=>vm.connectionRoute==='site'&&vm.setupMode!=='assisted'&&vm.assistedTop!==true&&['f10','f11','f12','f15'].includes(vm.screen);

export function siteTutorial(key){
  if(['workOpen','workEnter','workFile'].includes(key)){
    const first=key==='workOpen',file=key==='workFile';
    return plate(key,`<div class="h10-site-chat-top"><strong>ChatGPT</strong>${icon('chevron')}<small>${t('illustration')}</small></div>
      <div class="h10-site-chat-body">
        <div class="h10-site-modes"><span>${t('chat')}</span><span class="h10-site-work${first?' h10-site-highlight':''}">Work</span></div>
        ${first?`<h3>${t('chatHeading')}</h3>`:''}
        <div class="h10-site-composer${first?' is-empty':''}">
          ${first?'':`<span class="h10-site-attachment${file?' is-file':''}">${file?t('fileName'):'@ Sites'}</span>`}
          <p>${t(first?'placeholder':file?'fileExample':'promptExample')}</p>
          <div class="h10-site-composer-tools">${icon('plus')}<span class="h10-site-send${first?'':' h10-site-highlight'}">${icon(first?'send-idle':'send')}</span></div>
        </div>
      </div>${first?`<span class="h10-site-cursor">${icon('cursor')}</span>`:''}`);
  }
  if(key==='credentialCopy')return plate(key,`<div class="h10-site-code-example"><strong>${t('connectMac')}</strong><p>${t('codeIntroduction')}</p><div class="h10-site-code"><div><span>${t('codeLabel')}</span><span class="h10-site-copy h10-site-highlight">${icon('copy')}${esc(uiText('ui.h10.views.copy'))}</span></div><p class="h10-site-hidden-code">•••••••• · •••••••• · ••••••••</p></div><small>${t('codeHidden')}</small></div>`);
  if(key==='siteConnect')return plate(key,`<div class="h10-site-connect-example">${titlebar(t('connectTitle'))}<div class="h10-site-explanation">${['permissions','data','risk'].map(part=>`<div><strong>${t(`${part}Title`)}</strong><p>${t(`${part}Body`)}</p></div>`).join('')}</div><div class="h10-site-connect-example-button h10-site-highlight">${t('connectTitle')}</div></div>`);
  if(key==='sitePermissions')return plate(key,`<div class="h10-site-permissions-example">${titlebar(t('permissionsHeading'))}<p>${t('permissionsIntroduction')}</p><div class="h10-site-permission-options">${['ask','read','low','all'].map(part=>`<div class="h10-site-permission-option${part==='all'?' is-selected':''}"><span class="h10-site-example-radio">${part==='all'?icon('selected-radio'):''}</span><div><strong>${t(`${part}Title`)}${['low','all'].includes(part)?`<em>${t(part==='low'?'defaultTag':'riskTag')}</em>`:''}</strong><p>${t(`${part}Body`)}</p></div></div>`).join('')}</div></div>`);
  throw new TypeError(`Unknown manual Site tutorial: ${key}`);
}
