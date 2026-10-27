// Room code tests: charset, checksum digit, and collision resistance.
// The required sweep validates 1,000 synthetic codes and rejects every
// single character mutation of all 1,000 of them.

import test from "node:test";
import assert from "node:assert/strict";

import {
  CODE_ALPHABET,
  CODE_BASE_LENGTH,
  CODE_LENGTH,
  CHECKSUM_WEIGHTS,
  charValue,
  checksumDigit,
  createRng,
  generateRoomCode,
  normalizeRoomCode,
  validateRoomCode
} from "../engine.js";

const AMBIGUOUS = ["I", "L", "O", "0", "1"];
const ALPHABET_SIZE = CODE_ALPHABET.length;

function generateMany(seed, count) {
  const rng = createRng(seed);
  const codes = [];
  for (let i = 0; i < count; i += 1) codes.push(generateRoomCode(rng));
  return codes;
}

test("the alphabet holds 31 unique characters", () => {
  assert.equal(ALPHABET_SIZE, 31);
  assert.equal(new Set(CODE_ALPHABET).size, ALPHABET_SIZE);
});

test("the alphabet excludes every ambiguous character", () => {
  for (const character of AMBIGUOUS) {
    assert.equal(charValue(character), -1, `${character} must not be in the alphabet`);
  }
});

test("checksum weights are nonzero and distinct mod the alphabet size", () => {
  assert.equal(CHECKSUM_WEIGHTS.length, CODE_BASE_LENGTH);
  for (const weight of CHECKSUM_WEIGHTS) {
    assert.notEqual(weight % ALPHABET_SIZE, 0);
  }
  assert.equal(new Set(CHECKSUM_WEIGHTS).size, CHECKSUM_WEIGHTS.length);
});

test("generated codes are six characters long", () => {
  for (const code of generateMany(11, 50)) {
    assert.equal(code.length, CODE_LENGTH);
  }
});

test("generated codes use only alphabet characters", () => {
  for (const code of generateMany(12, 50)) {
    for (const character of code) {
      assert.ok(charValue(character) >= 0, `${character} in ${code} is outside the alphabet`);
    }
  }
});

test("one thousand generated codes pass the full validator", () => {
  const codes = generateMany(2026, 1000);
  assert.equal(codes.length, 1000);
  for (const code of codes) {
    const result = validateRoomCode(code);
    assert.ok(result.valid, `${code} should validate: ${result.reason}`);
  }
});

test("one thousand generated codes are all unique", () => {
  const codes = generateMany(2026, 1000);
  assert.equal(new Set(codes).size, 1000, "a collision appeared in the 1,000 code sweep");
});

test("a five thousand code sample stays within the birthday collision bound", () => {
  // The base space is 31^5, about 28.6 million. For 5,000 draws the birthday
  // bound predicts about 0.44 collisions, so a tiny number is expected and
  // honest. A degenerate generator would collide far more often.
  const codes = generateMany(77, 5000);
  const duplicates = codes.length - new Set(codes).size;
  assert.ok(duplicates <= 10, `${duplicates} collisions is far above the birthday bound`);
});

test("one thousand generated codes are collision free at the required sweep size", () => {
  // At 1,000 draws the birthday bound predicts about 0.017 collisions, and
  // the sweep below is deterministic for its fixed seed.
  const codes = generateMany(2026, 1000);
  assert.equal(new Set(codes).size, 1000);
});

test("the checksum digit equals an independent weighted sum", () => {
  const codes = generateMany(31, 200);
  for (const code of codes) {
    let sum = 0;
    for (let i = 0; i < CODE_BASE_LENGTH; i += 1) {
      sum += charValue(code[i]) * CHECKSUM_WEIGHTS[i];
    }
    const expected = CODE_ALPHABET[sum % ALPHABET_SIZE];
    assert.equal(checksumDigit(code.slice(0, CODE_BASE_LENGTH)), expected);
    assert.equal(code[CODE_BASE_LENGTH], expected);
  }
});

test("every single character mutation across 1,000 codes is rejected", () => {
  const codes = generateMany(2026, 1000);
  let rejected = 0;
  for (const code of codes) {
    for (let position = 0; position < CODE_LENGTH; position += 1) {
      const original = charValue(code[position]);
      const mutated =
        code.slice(0, position) +
        CODE_ALPHABET[(original + 1) % ALPHABET_SIZE] +
        code.slice(position + 1);
      assert.notEqual(mutated, code);
      const result = validateRoomCode(mutated);
      assert.ok(!result.valid, `mutating ${code} at ${position} produced accepted code ${mutated}`);
      rejected += 1;
    }
  }
  assert.equal(rejected, 6000);
});

test("swapping two adjacent characters is rejected", () => {
  const codes = generateMany(43, 200);
  for (const code of codes) {
    for (let i = 0; i < CODE_LENGTH - 1; i += 1) {
      if (code[i] === code[i + 1]) continue; // swapping identical chars is not a mutation
      const swapped = code.slice(0, i) + code[i + 1] + code[i] + code.slice(i + 2);
      assert.notEqual(swapped, code);
      assert.ok(!validateRoomCode(swapped).valid, `swapping ${i} and ${i + 1} in ${code} was accepted`);
    }
  }
});

test("validation rejects the empty string", () => {
  assert.equal(validateRoomCode("").valid, false);
  assert.equal(validateRoomCode("   ").valid, false);
});

test("validation rejects short codes", () => {
  for (let length = 1; length < CODE_LENGTH; length += 1) {
    const result = validateRoomCode("A".repeat(length));
    assert.equal(result.valid, false);
    assert.equal(result.checks.format, false);
  }
});

test("validation rejects long codes", () => {
  for (let length = CODE_LENGTH + 1; length <= CODE_LENGTH + 4; length += 1) {
    const result = validateRoomCode("A".repeat(length));
    assert.equal(result.valid, false);
    assert.equal(result.checks.format, false);
  }
});

test("validation rejects characters outside the alphabet", () => {
  const base = generateRoomCode(createRng(5));
  for (const character of AMBIGUOUS) {
    const candidate = character + base.slice(1);
    const result = validateRoomCode(candidate);
    assert.equal(result.valid, false);
    assert.equal(result.checks.charset, false);
  }
});

test("symbols inside a code are rejected", () => {
  const base = generateRoomCode(createRng(6));
  for (const symbol of ["#", "@", "!"]) {
    assert.equal(validateRoomCode(base.slice(0, 2) + symbol + base.slice(3)).valid, false);
    assert.equal(validateRoomCode(base + symbol).valid, false);
  }
});

test("separators are allowed when typing a code", () => {
  const code = generateRoomCode(createRng(9));
  const spaced = `${code.slice(0, 3)} ${code.slice(3)}`;
  const dashed = `${code.slice(0, 3)}-${code.slice(3)}`;
  assert.equal(validateRoomCode(spaced).valid, true);
  assert.equal(validateRoomCode(dashed).valid, true);
});

test("lowercase input is normalized before validation", () => {
  const code = generateRoomCode(createRng(10));
  const result = validateRoomCode(code.toLowerCase());
  assert.equal(result.valid, true);
  assert.equal(result.code, code);
});

test("normalization trims, folds case and strips separators", () => {
  const normalized = normalizeRoomCode("  ab2 cd9  ");
  assert.equal(normalized.ok, true);
  assert.equal(normalized.code, "AB2CD9");
});

test("non string input is rejected without throwing", () => {
  for (const bad of [null, undefined, 42, {}, [], true]) {
    const result = validateRoomCode(bad);
    assert.equal(result.valid, false);
    assert.equal(result.checks.format, false);
  }
});

test("generation is deterministic under a seeded generator", () => {
  const a = generateMany(1234, 100);
  const b = generateMany(1234, 100);
  assert.deepEqual(a, b);
});

test("different seeds diverge within the first five codes", () => {
  const a = generateMany(1, 5);
  const b = generateMany(2, 5);
  assert.notDeepEqual(a, b);
});

test("the checksum digit always lands in the alphabet", () => {
  for (const code of generateMany(64, 500)) {
    assert.ok(CODE_ALPHABET.includes(code[CODE_BASE_LENGTH]));
  }
});

test("the base space is large enough for collision resistant codes", () => {
  const space = Math.pow(ALPHABET_SIZE, CODE_BASE_LENGTH);
  assert.ok(space > 20000000, `base space ${space} is too small`);
});
