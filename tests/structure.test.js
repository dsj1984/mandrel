import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const AGENTS = path.join(ROOT, '.agents');

// ---------------------------------------------------------------------------
// Helper
// ---------------------------------------------------------------------------
function agentsPath(...parts) {
  return path.join(AGENTS, ...parts);
}

// ---------------------------------------------------------------------------
// Core file existence
// ---------------------------------------------------------------------------
describe('Core .agents/ files', () => {
  const coreRequired = ['default-agentrc.json', 'instructions.md', 'README.md'];

  for (const file of coreRequired) {
    it(`${file} exists`, () => {
      assert.ok(
        fs.existsSync(agentsPath(file)),
        `Missing required file: .agents/${file}`,
      );
    });
  }

  it('rules/ directory exists', () => {
    assert.ok(
      fs.existsSync(agentsPath('rules')),
      'Missing .agents/rules/ directory',
    );
  });

  const personasDir = agentsPath('personas');
  if (fs.existsSync(personasDir)) {
    const personas = fs
      .readdirSync(personasDir)
      .filter((file) => file.endsWith('.md'));

    assert.ok(
      personas.length > 0,
      '.agents/personas/ contains no markdown files',
    );

    for (const personaFile of personas) {
      it(`Persona ${personaFile} has structural integrity (# Role:)`, () => {
        const content = fs.readFileSync(
          agentsPath('personas', personaFile),
          'utf8',
        );
        assert.ok(
          content.includes('# Role:'),
          `Persona ${personaFile} is missing the required '# Role:' header`,
        );
      });
    }
  } else {
    it('personas/ directory exists', () => {
      assert.fail('Missing .agents/personas/ directory');
    });
  }
});

// ---------------------------------------------------------------------------
// Skills — every skill directory must contain a SKILL.md
// ---------------------------------------------------------------------------
describe('Skills — each directory must contain SKILL.md', () => {
  const skillsDir = agentsPath('skills');

  if (!fs.existsSync(skillsDir)) {
    it('skills/ directory exists', () => {
      assert.fail('Missing .agents/skills/ directory');
    });
  } else {
    // Collect all skills by looking for SKILL.md files recursively (2 levels deep)
    const skillsFound = [];

    const items = fs.readdirSync(skillsDir, { withFileTypes: true });
    for (const item of items) {
      if (!item.isDirectory()) continue;

      const itemPath = path.join(skillsDir, item.name);

      // Check if this item IS a skill (contains SKILL.md)
      if (fs.existsSync(path.join(itemPath, 'SKILL.md'))) {
        skillsFound.push({ name: item.name, path: itemPath });
      } else {
        // Check if this is a category containing skills
        const subItems = fs.readdirSync(itemPath, { withFileTypes: true });
        for (const subItem of subItems) {
          if (!subItem.isDirectory()) continue;
          const subItemPath = path.join(itemPath, subItem.name);
          if (fs.existsSync(path.join(subItemPath, 'SKILL.md'))) {
            skillsFound.push({
              name: `${item.name}/${subItem.name}`,
              path: subItemPath,
            });
          }
        }
      }
    }

    assert.ok(
      skillsFound.length > 0,
      '.agents/skills/ contains no skill definitions',
    );

    for (const skill of skillsFound) {
      it(`${skill.name} has a valid SKILL.md`, () => {
        const content = fs.readFileSync(
          path.join(skill.path, 'SKILL.md'),
          'utf8',
        );
        assert.ok(
          content.trim().length > 0,
          `Skill ${skill.name} has an empty SKILL.md`,
        );
      });
    }
  }
});

// ---------------------------------------------------------------------------
// Workflows — every workflow file must contain the ## Constraint heading
// ---------------------------------------------------------------------------
describe('Workflows — each file must contain ## Constraint', () => {
  const workflowsDir = agentsPath('workflows');

  if (!fs.existsSync(workflowsDir)) {
    it('workflows/ directory exists', () => {
      assert.fail('Missing .agents/workflows/ directory');
    });
  } else {
    // Exclude the authoring guide (`README.md`) — it documents workflow
    // conventions for human authors, not a slash-command workflow itself,
    // so the `## Constraint` heading requirement does not apply.
    const workflows = fs
      .readdirSync(workflowsDir)
      .filter(
        (filename) => filename.endsWith('.md') && filename !== 'README.md',
      );

    assert.ok(
      workflows.length > 0,
      '.agents/workflows/ contains no markdown files',
    );

    for (const workflow of workflows) {
      it(`${workflow} contains ## Constraint`, () => {
        const content = fs.readFileSync(
          agentsPath('workflows', workflow),
          'utf8',
        );
        assert.ok(
          content.includes('## Constraint'),
          `${workflow} is missing the required ## Constraint section`,
        );
      });
    }
  }
});

// ---------------------------------------------------------------------------
// v5 Infrastructure — ticketing provider and config
// ---------------------------------------------------------------------------
describe('v5 Infrastructure files', () => {
  const v5Files = [
    'scripts/lib/ITicketingProvider.js',
    'scripts/lib/config-resolver.js',
    'scripts/lib/provider-factory.js',
    'scripts/providers/github.js',
    'scripts/agents-bootstrap-github.js',
  ];

  for (const file of v5Files) {
    it(`${file} exists`, () => {
      assert.ok(
        fs.existsSync(agentsPath(file)),
        `Missing v5 file: .agents/${file}`,
      );
    });
  }

  it('ITicketingProvider exports a class', async () => {
    const mod = await import(
      pathToFileURL(
        path.join(AGENTS, 'scripts', 'lib', 'ITicketingProvider.js'),
      ).href
    );
    assert.ok(
      typeof mod.ITicketingProvider === 'function',
      'ITicketingProvider must be a class',
    );
  });

  it('config-resolver exports validateOrchestrationConfig', async () => {
    const mod = await import(
      pathToFileURL(path.join(AGENTS, 'scripts', 'lib', 'config-resolver.js'))
        .href
    );
    assert.ok(
      typeof mod.validateOrchestrationConfig === 'function',
      'config-resolver must export validateOrchestrationConfig',
    );
  });
});
