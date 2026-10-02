// Tiny no-deps i18n helper. Strings are namespaced by feature; lookups
// fall back to the English bundle when a key is missing. New translations
// can be added by dropping another bundle into `bundles` below.

import {en} from './i18n/en.js';
import {fr} from './i18n/fr.js';

const bundles=/** @type {Record<string,Record<string,string>>} */({en,fr});

let _lang='en';
const languageListeners=new Set();

/** Subscribe to UI language changes. Returns an unsubscribe function.
 * @param {() => void} listener
 */
export function onLanguageChange(listener){
  languageListeners.add(listener);
  return ()=>languageListeners.delete(listener);
}

/** Set the active language code. Falls back to English if unknown. */
export function setLang(code){
  const next=bundles[code]?code:'en';
  if(next===_lang)return;
  _lang=next;
  languageListeners.forEach(listener=>listener());
}

/** Return the active language code. */
export function getLang(){return _lang;}

/** Return the list of available language codes. */
export function availableLangs(){return Object.keys(bundles);}

// Resolve a key against the active bundle, falling back to English, then to
// the key itself. `vars` (if provided) substitutes `{name}` style placeholders.
/**
 * @param {string} key
 * @param {Record<string,string|number>=} vars
 */
export function t(key,vars){
  const bundle=bundles[_lang]||bundles.en;
  let s=bundle[key];
  if(typeof s!=='string')s=bundles.en[key];
  if(typeof s!=='string')s=key;
  if(vars){
    for(const k of Object.keys(vars)){
      s=s.replaceAll('{'+k+'}',()=>String(vars[k]));
    }
  }
  return s;
}

// Register an additional translation bundle. Useful for plugins or for users
// who paste a JSON dictionary in the settings panel.
/**
 * @param {string} code
 * @param {Record<string,string>} dict
 */
export function registerBundle(code,dict){
  if(!code||typeof dict!=='object')return;
  bundles[code]={...(bundles[code]||{}),...dict};
}
