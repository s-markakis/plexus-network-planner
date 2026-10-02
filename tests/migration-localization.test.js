import {afterEach,describe,it,expect} from 'vitest';
import {setLang} from '../files/src/i18n.js';
import {localizeMigrationMessage} from '../files/src/localizeMigration.js';
import {migrateProject,PROJECT_VERSION} from '../files/src/migrate.js';

afterEach(()=>setLang('en'));
describe('migration diagnostic localization at the UI boundary',()=>{
  it('keeps migration API diagnostics stable and translates the displayed version',()=>{
    setLang('fr');
    const [,warnings]=migrateProject({version:PROJECT_VERSION+1,floors:[]});
    expect(warnings).toEqual([`Project was saved with a newer version (v${PROJECT_VERSION+1}) — some fields may be ignored.`]);
    expect(localizeMigrationMessage(warnings[0])).toBe(`Le projet a été enregistré avec une version plus récente (v${PROJECT_VERSION+1}) — certains champs peuvent être ignorés.`);
    setLang('en');expect(localizeMigrationMessage(warnings[0])).toBe(warnings[0]);
  });
  it('translates known shape errors and preserves unknown parser diagnostics verbatim',()=>{
    setLang('fr');
    expect(()=>migrateProject(null)).toThrow('Not a Plexus project file');
    expect(localizeMigrationMessage('Not a Plexus project file')).toBe('Ce fichier n’est pas un projet Plexus');
    expect(localizeMigrationMessage('Missing floors')).toBe('Étages manquants');
    const raw='SyntaxError: literal $& <model> v11';
    expect(localizeMigrationMessage(raw)).toBe(raw);
  });
});
