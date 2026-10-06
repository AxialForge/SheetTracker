'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const C = require('../app/shared/compare');

test('numeric-aware equality', () => {
  assert.ok(C.same('2300', '2300.0'));
  assert.ok(C.same(' 14.25 ', '14.250'));
  assert.ok(!C.same('2300', '2301'));
  assert.ok(C.same('H123', 'h123'));
});
test('blanks never count as change or drift', () => {
  assert.equal(C.changed('', '5'), false);
  assert.equal(C.changed('5', ''), false);
  assert.equal(C.changed(null, '5'), false);
  assert.equal(C.drifted('', '5'), false);
});
test('changed / drifted', () => {
  assert.equal(C.changed('2250', '2275'), true);
  assert.equal(C.changed('2250', '2250.0'), false);
  assert.equal(C.drifted('2250', '2275'), true);
  assert.equal(C.drifted('2250', '2250'), false);
});
