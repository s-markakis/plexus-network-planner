import {t} from './i18n.js';

// Translate migration diagnostics at the UI boundary. The migration API and
// its English diagnostics remain stable for callers and saved-project handling.
/** @param {string} message */
export function localizeMigrationMessage(message){
  if(message==='Not a Plexus project file')return t('migration.invalid_project');
  if(message==='Missing floors')return t('migration.missing_floors');
  const match=/^Project was saved with a newer version \(v(.+)\) — some fields may be ignored\.$/.exec(message);
  return match?t('migration.newer_version',{version:match[1]}):message;
}
