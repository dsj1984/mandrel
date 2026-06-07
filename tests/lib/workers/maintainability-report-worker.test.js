import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { handleMaintainabilityReportWorkerMessage } from '../../../.agents/scripts/lib/workers/maintainability-report-worker.js';

describe('handleMaintainabilityReportWorkerMessage — control messages', () => {
  it('exit:true returns kind=exit', () => {
    assert.deepEqual(handleMaintainabilityReportWorkerMessage({ exit: true }), {
      kind: 'exit',
    });
  });

  it('rejects null/undefined messages', () => {
    const out = handleMaintainabilityReportWorkerMessage(null);
    assert.equal(out.kind, 'reply');
    assert.equal(out.message.ok, false);
    assert.match(out.message.error, /bad worker message/);
  });

  it('rejects messages with non-string item', () => {
    const out = handleMaintainabilityReportWorkerMessage({ item: 42 });
    assert.equal(out.message.ok, false);
  });

  it('rejects a source-item missing source or label', () => {
    assert.equal(
      handleMaintainabilityReportWorkerMessage({ item: { source: 'x' } })
        .message.ok,
      false,
    );
    assert.equal(
      handleMaintainabilityReportWorkerMessage({ item: { label: 'a.js' } })
        .message.ok,
      false,
    );
  });
});

describe('handleMaintainabilityReportWorkerMessage — source-item path (Story #3696)', () => {
  it('scores a pre-sourced { source, label } item via reportFromSource', () => {
    const report = {
      moduleScore: 99,
      methods: [],
      worstMethod: null,
      meanMethod: null,
      parseError: false,
    };
    const out = handleMaintainabilityReportWorkerMessage(
      { item: { source: 'export const a = 1;', label: 'a.js' } },
      { reportFromSource: () => report },
    );
    assert.equal(out.message.ok, true);
    assert.deepEqual(out.message.result, { filePath: 'a.js', report });
  });

  it('scores real source content end-to-end (no injected scorer)', () => {
    const out = handleMaintainabilityReportWorkerMessage({
      item: {
        source: 'export function add(a, b) {\n  return a + b;\n}\n',
        label: 'add.js',
      },
    });
    assert.equal(out.message.ok, true);
    assert.equal(out.message.result.report.parseError, false);
    assert.ok(out.message.result.report.moduleScore > 0);
  });
});

describe('handleMaintainabilityReportWorkerMessage — report path', () => {
  it('returns the computed report on success', () => {
    const report = {
      moduleScore: 42.5,
      methods: [],
      worstMethod: null,
      meanMethod: null,
      parseError: false,
    };
    const out = handleMaintainabilityReportWorkerMessage(
      { item: '/abs/foo.js' },
      { report: () => report },
    );
    assert.equal(out.message.ok, true);
    assert.deepEqual(out.message.result, {
      filePath: '/abs/foo.js',
      report,
    });
  });

  it('passes a parse-error report straight through (no special-casing)', () => {
    const report = {
      moduleScore: 0,
      methods: [],
      worstMethod: null,
      meanMethod: null,
      parseError: true,
    };
    const out = handleMaintainabilityReportWorkerMessage(
      { item: '/abs/foo.js' },
      { report: () => report },
    );
    assert.equal(out.message.result.report.parseError, true);
    assert.equal('error' in out.message.result, false);
  });

  it('catches Error from report(), surfaces null report + .error message', () => {
    const out = handleMaintainabilityReportWorkerMessage(
      { item: '/abs/gone.js' },
      {
        report: () => {
          throw new Error('File not found: /abs/gone.js');
        },
      },
    );
    assert.equal(out.message.ok, true);
    assert.equal(out.message.result.report, null);
    assert.match(out.message.result.error, /File not found/);
  });

  it('catches non-Error throws and stringifies them', () => {
    const out = handleMaintainabilityReportWorkerMessage(
      { item: '/abs/foo.js' },
      {
        report: () => {
          throw 'string thrown';
        },
      },
    );
    assert.equal(out.message.result.report, null);
    assert.equal(out.message.result.error, 'string thrown');
  });
});
