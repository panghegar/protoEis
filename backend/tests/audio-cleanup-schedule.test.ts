import {test} from 'node:test';
import assert from 'node:assert/strict';
import {isFirstDayInJakarta} from '../src/services/audio-cleanup-schedule.js';

test('monthly midnight cleanup uses the Jakarta calendar across 28/29/30/31-day months',()=>{
 const cases:[string,boolean][]=[
  ['2026-11-30T16:59:59.999Z',false], // November 30, 23:59:59.999 WIB
  ['2026-11-30T17:00:00.000Z',true],  // December 1, 00:00 WIB
  ['2026-11-30T17:59:59.999Z',true],  // Hobby scheduling window
  ['2026-12-01T17:00:00.000Z',false], // December 2, 00:00 WIB
  ['2026-12-31T17:00:00.000Z',true],  // January 1, next year
  ['2027-01-31T17:00:00.000Z',true],
  ['2027-02-27T17:00:00.000Z',false],
  ['2027-02-28T17:00:00.000Z',true],  // Non-leap February
  ['2028-02-28T17:00:00.000Z',false], // Leap February 29, not March 1
  ['2028-02-29T17:00:00.000Z',true],
  ['2027-04-29T17:00:00.000Z',false],
  ['2027-04-30T17:00:00.000Z',true],
 ];
 for(const [iso,expected] of cases)assert.equal(isFirstDayInJakarta(new Date(iso)),expected,iso);
});
