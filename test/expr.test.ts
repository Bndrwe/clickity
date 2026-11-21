import test from 'node:test';
import assert from 'node:assert/strict';
import { evalConst, evalExpr, exprOf, parseExpr } from '../src/shared/expr.ts';

const near = (a: number, b: number, eps = 1e-9): void => assert.ok(Math.abs(a - b) < eps, `${a} ≈ ${b}`);

test('arithmetic, precedence and powers', () => {
  near(evalExpr('1 + 2 * 3'), 7);
  near(evalExpr('(1 + 2) * 3'), 9);
  near(evalExpr('2^3^2'), 512); // right-associative
  near(evalExpr('-2^2'), -4); // -(2^2)
  near(evalExpr('2^-1'), 0.5);
  near(evalExpr('10 / 4 - 1'), 1.5);
  near(evalExpr('2 ** 3'), 8);
  near(evalExpr('1e3 + .5'), 1000.5);
});

test('x, implicit multiplication and superscripts', () => {
  near(evalExpr('x^2 - 3', 2), 1);
  near(evalExpr('2x + 3', 4), 11);
  near(evalExpr('3(x + 1)', 1), 6);
  near(evalExpr('(x + 1)(x - 1)', 3), 8);
  near(evalExpr('x²', 3), 9);
  near(evalExpr('2x³', 2), 16);
  near(evalExpr('x(x+1)', 2), 6);
  near(evalExpr('−x', 2), -2); // unicode minus
  near(evalExpr('3 × x ÷ 2', 2), 3);
});

test('functions and constants', () => {
  near(evalExpr('sin(x)', Math.PI / 2), 1);
  near(evalExpr('sin x', Math.PI / 2), 1);
  near(evalExpr('2sin(x)cos(x)', 0.3), Math.sin(0.6));
  near(evalExpr('sqrt(16) + abs(-2)'), 6);
  near(evalExpr('ln(e)'), 1);
  near(evalExpr('log(1000)'), 3);
  near(evalExpr('log2(8)'), 3);
  near(evalExpr('exp(0) + max(1, 4, 2)'), 5);
  near(evalExpr('2pi'), 2 * Math.PI);
  near(evalExpr('π'), Math.PI);
  near(evalExpr('sinx', 0), 0); // glued names split
  near(evalExpr('√x', 9), 3);
  near(evalExpr('sinh(0) + cosh(0)'), 1);
});

test('rejects anything that is not math (no eval)', () => {
  for (const bad of ['', '   ', 'x +', '(x', 'x)', 'foo(x)', 'alert(1)', 'process.exit()', 'x = 2', 'y; x', '[1]', 'x $ 2', 'a + b', '1 +* 2', 'constructor', '__proto__']) {
    assert.equal(parseExpr(bad), null, bad);
  }
  assert.equal(parseExpr('x+'.repeat(100) + 'x'), null); // too long
  assert.equal(parseExpr('('.repeat(60) + 'x' + ')'.repeat(60)), null); // too deep
  assert.ok(Number.isNaN(evalExpr('nope')));
});

test('non-finite results are numbers, not throws', () => {
  assert.equal(evalExpr('1/x', 0), Infinity);
  assert.ok(Number.isNaN(evalExpr('sqrt(x)', -1)));
});

test('exprOf takes the right-hand side of an equation', () => {
  assert.equal(exprOf('y = 2x + 3'), '2x + 3');
  assert.equal(exprOf('f(x) = sin(x)'), 'sin(x)');
  assert.equal(exprOf('Y=x^2'), 'x^2');
  assert.equal(exprOf('$x^2$'), 'x^2');
  assert.equal(exprOf('x^2'), 'x^2');
  assert.equal(exprOf('a = b = c'), null);
});

test('evalConst for range bounds', () => {
  assert.equal(evalConst('-4'), -4);
  near(evalConst('-2pi')!, -2 * Math.PI);
  assert.equal(evalConst('3/2'), 1.5);
  assert.equal(evalConst('max(1, 2)'), 2);
  assert.equal(evalConst('x'), null);
  assert.equal(evalConst('1/0'), null);
});
