import { fileURLToPath } from 'node:url';
import { validateSkillLibrary } from '../packages/design-agent/dist/skill-library.js';

const root = fileURLToPath(new URL('../.pi/skills', import.meta.url));
const issues = await validateSkillLibrary(root);
for (const issue of issues) console.error(`${issue.path}: ${issue.code}: ${issue.message}`);
if (issues.length) process.exitCode = 1;
else console.log('Bundled Skill structure and metadata are valid.');
