import {t,getLang} from './i18n.js';

const attributes=['title','aria-label','placeholder','alt','label'];
const selector=['[data-i18n]',...attributes.map(a=>`[data-i18n-${a}]`)].join(',');

/** Mark a text-only UI node for translation now and on subsequent language changes.
 * Keep icons, controls, user content and counters in separate, unmarked nodes.
 * @param {Element} element
 * @param {string} key
 */
export function localizeText(element,key){
  element.setAttribute('data-i18n',key);
  element.textContent=t(key);
}

/** Translate only explicitly marked UI nodes, without recreating their parents.
 * @param {Document|Element} root
 */
export function localizeDOM(root=document){
  const nodes=[...root.querySelectorAll(selector)];
  if(root instanceof Element && root.matches(selector))nodes.unshift(root);
  for(const element of nodes){
    // Parameters belong to display text only, never to a control's stored value.
    const vars=JSON.parse(element.getAttribute('data-i18n-vars')||'null');
    const key=element.getAttribute('data-i18n');
    if(key)element.textContent=t(key,vars);
    for(const attr of attributes){
      const attrKey=element.getAttribute('data-i18n-'+attr);
      if(attrKey)element.setAttribute(attr,t(attrKey,vars));
    }
  }
  if(root.nodeType===9)/** @type {Document} */(root).documentElement.lang=getLang();
}
