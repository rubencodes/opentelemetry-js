/*
 * Copyright The OpenTelemetry Authors
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      https://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { diag } from '@opentelemetry/api';
import * as api from '@opentelemetry/api-metrics';
import { hrTime, hrTimeToNanoseconds } from '@opentelemetry/core';
import { Resource } from '@opentelemetry/resources';
import * as assert from 'assert';
import * as sinon from 'sinon';
import {
  CounterMetric,
  Histogram,
  LastValue,
  LastValueAggregator,
  Meter,
  MeterProvider,
  Metric,
  MetricKind,
  MetricRecord,
  Sum,
  UpDownCounterMetric,
  ObservableGaugeMetric,
  HistogramMetric,
} from '../src';
import { SumAggregator } from '../src/export/aggregators';
import { ObservableCounterMetric } from '../src/ObservableCounterMetric';
import { ObservableUpDownCounterMetric } from '../src/ObservableUpDownCounterMetric';
import { hashAttributes } from '../src/Utils';

const nonNumberValues = [
  // type undefined
  undefined,
  // type null
  null,
  // type function
  function () {},
  // type boolean
  true,
  false,
  // type string
  '1',
  // type object
  {},
  // type symbol
  // symbols cannot be cast to number, early errors will be thrown.
];

if (Number(process.versions.node.match(/^\d+/)) >= 10) {
  nonNumberValues.push(
    // type bigint
    // Preferring BigInt builtin object instead of bigint literal to keep Node.js v8.x working.
    // TODO: should metric instruments support bigint?
    BigInt(1) // eslint-disable-line node/no-unsupported-features/es-builtins
  );
}

describe('Meter', () => {
  let meter: Meter;
  const keya = 'keya';
  const keyb = 'keyb';
  const attributes: api.Attributes = { [keyb]: 'value2', [keya]: 'value1' };

  beforeEach(() => {
    meter = new MeterProvider().getMeter('test-meter');
  });

  afterEach(() => {
    sinon.restore();
  });

  describe('#counter', () => {
    const performanceTimeOrigin = hrTime();

    it('should create a counter', () => {
      const counter = meter.createCounter('name');
      assert.ok(counter instanceof Metric);
    });

    it('should create a counter with options', () => {
      const counter = meter.createCounter('name', {
        description: 'desc',
        unit: '1',
        disabled: false,
      });
      assert.ok(counter instanceof Metric);
    });

    it('should be able to call add() directly on counter', async () => {
      const counter = meter.createCounter('name') as CounterMetric;
      counter.add(10, attributes);
      await meter.collect();
      const [record1] = meter.getProcessor().checkPointSet();

      assert.strictEqual(record1.aggregator.toPoint().value, 10);
      const lastTimestamp = record1.aggregator.toPoint().timestamp;
      assert.ok(
        hrTimeToNanoseconds(lastTimestamp) >
          hrTimeToNanoseconds(performanceTimeOrigin)
      );
      counter.add(10, attributes);
      assert.strictEqual(record1.aggregator.toPoint().value, 20);

      assert.ok(
        hrTimeToNanoseconds(record1.aggregator.toPoint().timestamp) >
          hrTimeToNanoseconds(lastTimestamp)
      );
    });

    it('should be able to call add with no attributes', async () => {
      const counter = meter.createCounter('name', {
        description: 'desc',
        unit: '1',
        disabled: false,
      });
      counter.add(1);
      await meter.collect();
      const [record1] = meter.getProcessor().checkPointSet();
      assert.strictEqual(record1.aggregator.toPoint().value, 1);
    });

    it('should pipe through resource', async () => {
      const counter = meter.createCounter('name') as CounterMetric;
      assert.ok(counter.resource instanceof Resource);

      counter.add(1, { foo: 'bar' });

      const [record] = await counter.getMetricRecord();
      assert.ok(record.resource instanceof Resource);
    });

    it('should pipe through instrumentation library', async () => {
      const counter = meter.createCounter('name') as CounterMetric;
      assert.ok(counter.instrumentationLibrary);

      counter.add(1, { foo: 'bar' });

      const [record] = await counter.getMetricRecord();
      const { name, version } = record.instrumentationLibrary;
      assert.strictEqual(name, 'test-meter');
      assert.strictEqual(version, undefined);
    });

    describe('.bind()', () => {
      it('should create a counter instrument', async () => {
        const counter = meter.createCounter('name') as CounterMetric;
        const boundCounter = counter.bind(attributes);
        boundCounter.add(10);
        await meter.collect();
        const [record1] = meter.getProcessor().checkPointSet();

        assert.strictEqual(record1.aggregator.toPoint().value, 10);
        boundCounter.add(10);
        assert.strictEqual(record1.aggregator.toPoint().value, 20);
      });

      it('should return the aggregator', () => {
        const counter = meter.createCounter('name') as CounterMetric;
        const boundCounter = counter.bind(attributes);
        boundCounter.add(20);
        assert.ok(boundCounter.getAggregator() instanceof SumAggregator);
        assert.strictEqual(boundCounter.getAttributes(), attributes);
      });

      it('should add positive values only', async () => {
        const counter = meter.createCounter('name') as CounterMetric;
        const boundCounter = counter.bind(attributes);
        boundCounter.add(10);
        assert.strictEqual(meter.getProcessor().checkPointSet().length, 0);
        await meter.collect();
        const [record1] = meter.getProcessor().checkPointSet();

        assert.strictEqual(record1.aggregator.toPoint().value, 10);
        boundCounter.add(-100);
        assert.strictEqual(record1.aggregator.toPoint().value, 10);
      });

      it('should not add the instrument data when disabled', async () => {
        const counter = meter.createCounter('name', {
          disabled: true,
        }) as CounterMetric;
        const boundCounter = counter.bind(attributes);
        boundCounter.add(10);
        await meter.collect();
        const [record1] = meter.getProcessor().checkPointSet();
        assert.strictEqual(record1.aggregator.toPoint().value, 0);
      });

      it('should return same instrument on same attribute values', async () => {
        const counter = meter.createCounter('name') as CounterMetric;
        const boundCounter = counter.bind(attributes);
        boundCounter.add(10);
        const boundCounter1 = counter.bind(attributes);
        boundCounter1.add(10);
        await meter.collect();
        const [record1] = meter.getProcessor().checkPointSet();

        assert.strictEqual(record1.aggregator.toPoint().value, 20);
        assert.strictEqual(boundCounter, boundCounter1);
      });
    });

    describe('.unbind()', () => {
      it('should remove a counter instrument', () => {
        const counter = meter.createCounter('name') as CounterMetric;
        const boundCounter = counter.bind(attributes);
        assert.strictEqual(counter['_instruments'].size, 1);
        counter.unbind(attributes);
        assert.strictEqual(counter['_instruments'].size, 0);
        const boundCounter1 = counter.bind(attributes);
        assert.strictEqual(counter['_instruments'].size, 1);
        assert.notStrictEqual(boundCounter, boundCounter1);
      });

      it('should not fail when removing non existing instrument', () => {
        const counter = meter.createCounter('name') as CounterMetric;
        counter.unbind({});
      });

      it('should clear all instruments', () => {
        const counter = meter.createCounter('name') as CounterMetric;
        counter.bind(attributes);
        assert.strictEqual(counter['_instruments'].size, 1);
        counter.clear();
        assert.strictEqual(counter['_instruments'].size, 0);
      });
    });

    describe('.registerMetric()', () => {
      it('skip already registered Metric', async () => {
        const counter1 = meter.createCounter('name1') as CounterMetric;
        counter1.bind(attributes).add(10);

        // should skip below metric
        const counter2 = meter.createCounter('name1', {
          valueType: api.ValueType.INT,
        }) as CounterMetric;
        counter2.bind(attributes).add(500);

        await meter.collect();
        const record = meter.getProcessor().checkPointSet();

        assert.strictEqual(record.length, 1);
        assert.deepStrictEqual(record[0].descriptor, {
          description: '',
          metricKind: MetricKind.COUNTER,
          name: 'name1',
          unit: '1',
          valueType: api.ValueType.DOUBLE,
        });
        assert.strictEqual(record[0].aggregator.toPoint().value, 10);
      });
    });

    describe('names', () => {
      it('should create counter with valid names', () => {
        const counter1 = meter.createCounter('name1');
        const counter2 = meter.createCounter(
          'Name_with-all.valid_CharacterClasses'
        );
        assert.ok(counter1 instanceof CounterMetric);
        assert.ok(counter2 instanceof CounterMetric);
      });

      it('should return no op metric if name is an empty string', () => {
        const counter = meter.createCounter('');
        assert.ok(counter instanceof api.NoopMetric);
      });

      it('should return no op metric if name does not start with a letter', () => {
        const counter1 = meter.createCounter('1name');
        const counter_ = meter.createCounter('_name');
        assert.ok(counter1 instanceof api.NoopMetric);
        assert.ok(counter_ instanceof api.NoopMetric);
      });

      it('should return no op metric if name is an empty string contain only letters, numbers, ".", "_", and "-"', () => {
        const counter = meter.createCounter('name with invalid characters^&*(');
        assert.ok(counter instanceof api.NoopMetric);
      });

      it('should return no op metric if name exceeded length of 63', () => {
        const counter = meter.createCounter('a'.repeat(63));
        assert.ok(counter instanceof CounterMetric);
        const counter2 = meter.createCounter('a'.repeat(64));
        assert.ok(counter2 instanceof api.NoopMetric);
      });
    });
  });

  describe('#UpDownCounter', () => {
    const performanceTimeOrigin = hrTime();

    it('should create a UpDownCounter', () => {
      const upDownCounter = meter.createUpDownCounter('name');
      assert.ok(upDownCounter instanceof Metric);
    });

    it('should create a UpDownCounter with options', () => {
      const upDownCounter = meter.createUpDownCounter('name', {
        description: 'desc',
        unit: '1',
        disabled: false,
      });
      assert.ok(upDownCounter instanceof Metric);
    });

    it('should be able to call add() directly on UpDownCounter', async () => {
      const upDownCounter = meter.createUpDownCounter('name');
      upDownCounter.add(10, attributes);
      await meter.collect();
      const [record1] = meter.getProcessor().checkPointSet();

      assert.strictEqual(record1.aggregator.toPoint().value, 10);
      const lastTimestamp = record1.aggregator.toPoint().timestamp;
      assert.ok(
        hrTimeToNanoseconds(lastTimestamp) >
          hrTimeToNanoseconds(performanceTimeOrigin)
      );
      upDownCounter.add(10, attributes);
      assert.strictEqual(record1.aggregator.toPoint().value, 20);

      assert.ok(
        hrTimeToNanoseconds(record1.aggregator.toPoint().timestamp) >
          hrTimeToNanoseconds(lastTimestamp)
      );
    });

    it('should be able to call add with no attributes', async () => {
      const upDownCounter = meter.createUpDownCounter('name', {
        description: 'desc',
        unit: '1',
        disabled: false,
      });
      upDownCounter.add(1);
      await meter.collect();
      const [record1] = meter.getProcessor().checkPointSet();
      assert.strictEqual(record1.aggregator.toPoint().value, 1);
    });

    it('should pipe through resource', async () => {
      const upDownCounter = meter.createUpDownCounter(
        'name'
      ) as UpDownCounterMetric;
      assert.ok(upDownCounter.resource instanceof Resource);

      upDownCounter.add(1, { foo: 'bar' });

      const [record] = await upDownCounter.getMetricRecord();
      assert.ok(record.resource instanceof Resource);
    });

    describe('.bind()', () => {
      it('should create a UpDownCounter instrument', async () => {
        const upDownCounter = meter.createUpDownCounter('name') as UpDownCounterMetric;
        const boundCounter = upDownCounter.bind(attributes);
        boundCounter.add(10);
        await meter.collect();
        const [record1] = meter.getProcessor().checkPointSet();

        assert.strictEqual(record1.aggregator.toPoint().value, 10);
        boundCounter.add(-200);
        assert.strictEqual(record1.aggregator.toPoint().value, -190);
      });

      it('should return the aggregator', () => {
        const upDownCounter = meter.createUpDownCounter(
          'name'
        ) as UpDownCounterMetric;
        const boundCounter = upDownCounter.bind(attributes);
        boundCounter.add(20);
        assert.ok(boundCounter.getAggregator() instanceof SumAggregator);
        assert.strictEqual(boundCounter.getAttributes(), attributes);
      });

      it('should not add the instrument data when disabled', async () => {
        const upDownCounter = meter.createUpDownCounter('name', {
          disabled: true,
        }) as UpDownCounterMetric;
        const boundCounter = upDownCounter.bind(attributes);
        boundCounter.add(10);
        await meter.collect();
        const [record1] = meter.getProcessor().checkPointSet();
        assert.strictEqual(record1.aggregator.toPoint().value, 0);
      });

      it('should return same instrument on same attribute values', async () => {
        const upDownCounter = meter.createUpDownCounter('name') as UpDownCounterMetric;
        const boundCounter = upDownCounter.bind(attributes);
        boundCounter.add(10);
        const boundCounter1 = upDownCounter.bind(attributes);
        boundCounter1.add(10);
        await meter.collect();
        const [record1] = meter.getProcessor().checkPointSet();

        assert.strictEqual(record1.aggregator.toPoint().value, 20);
        assert.strictEqual(boundCounter, boundCounter1);
      });

      it('should truncate non-integer values for INT valueType', async () => {
        const upDownCounter = meter.createUpDownCounter('name', {
          valueType: api.ValueType.INT,
        }) as UpDownCounterMetric;
        const boundCounter = upDownCounter.bind(attributes);

        [-1.1, 2.2].forEach(val => {
          boundCounter.add(val);
        });
        await meter.collect();
        const [record1] = meter.getProcessor().checkPointSet();
        assert.strictEqual(record1.aggregator.toPoint().value, 1);
      });

      it('should ignore non-number values for INT valueType', async () => {
        const upDownCounter = meter.createUpDownCounter('name', {
          valueType: api.ValueType.DOUBLE,
        }) as UpDownCounterMetric;
        const boundCounter = upDownCounter.bind(attributes);

        await Promise.all(
          nonNumberValues.map(async val => {
            // @ts-expect-error verify non number types
            boundCounter.add(val);
            await meter.collect();
            const [record1] = meter.getProcessor().checkPointSet();

            assert.strictEqual(record1.aggregator.toPoint().value, 0);
          })
        );
      });

      it('should ignore non-number values for DOUBLE valueType', async () => {
        const upDownCounter = meter.createUpDownCounter('name', {
          valueType: api.ValueType.DOUBLE,
        }) as UpDownCounterMetric;
        const boundCounter = upDownCounter.bind(attributes);

        await Promise.all(
          nonNumberValues.map(async val => {
            // @ts-expect-error verify non number types
            boundCounter.add(val);
            await meter.collect();
            const [record1] = meter.getProcessor().checkPointSet();

            assert.strictEqual(record1.aggregator.toPoint().value, 0);
          })
        );
      });
    });

    describe('.unbind()', () => {
      it('should remove a UpDownCounter instrument', () => {
        const upDownCounter = meter.createUpDownCounter(
          'name'
        ) as UpDownCounterMetric;
        const boundCounter = upDownCounter.bind(attributes);
        assert.strictEqual(upDownCounter['_instruments'].size, 1);
        upDownCounter.unbind(attributes);
        assert.strictEqual(upDownCounter['_instruments'].size, 0);
        const boundCounter1 = upDownCounter.bind(attributes);
        assert.strictEqual(upDownCounter['_instruments'].size, 1);
        assert.notStrictEqual(boundCounter, boundCounter1);
      });

      it('should not fail when removing non existing instrument', () => {
        const upDownCounter = meter.createUpDownCounter('name') as UpDownCounterMetric;
        upDownCounter.unbind({});
      });

      it('should clear all instruments', () => {
        const upDownCounter = meter.createUpDownCounter(
          'name'
        ) as CounterMetric;
        upDownCounter.bind(attributes);
        assert.strictEqual(upDownCounter['_instruments'].size, 1);
        upDownCounter.clear();
        assert.strictEqual(upDownCounter['_instruments'].size, 0);
      });
    });

    describe('.registerMetric()', () => {
      it('skip already registered Metric', async () => {
        const counter1 = meter.createCounter('name1') as CounterMetric;
        counter1.bind(attributes).add(10);

        // should skip below metric
        const counter2 = meter.createCounter('name1', {
          valueType: api.ValueType.INT,
        }) as CounterMetric;
        counter2.bind(attributes).add(500);

        await meter.collect();
        const record = meter.getProcessor().checkPointSet();

        assert.strictEqual(record.length, 1);
        assert.deepStrictEqual(record[0].descriptor, {
          description: '',
          metricKind: MetricKind.COUNTER,
          name: 'name1',
          unit: '1',
          valueType: api.ValueType.DOUBLE,
        });
        assert.strictEqual(record[0].aggregator.toPoint().value, 10);
      });
    });

    describe('names', () => {
      it('should create counter with valid names', () => {
        const counter1 = meter.createCounter('name1');
        const counter2 = meter.createCounter(
          'Name_with-all.valid_CharacterClasses'
        );
        assert.ok(counter1 instanceof CounterMetric);
        assert.ok(counter2 instanceof CounterMetric);
      });

      it('should return no op metric if name is an empty string', () => {
        const counter = meter.createCounter('');
        assert.ok(counter instanceof api.NoopMetric);
      });

      it('should return no op metric if name does not start with a letter', () => {
        const counter1 = meter.createCounter('1name');
        const counter_ = meter.createCounter('_name');
        assert.ok(counter1 instanceof api.NoopMetric);
        assert.ok(counter_ instanceof api.NoopMetric);
      });

      it('should return no op metric if name is an empty string contain only letters, numbers, ".", "_", and "-"', () => {
        const counter = meter.createCounter('name with invalid characters^&*(');
        assert.ok(counter instanceof api.NoopMetric);
      });
    });
  });

  describe('#Histogram', () => {
    it('should create a histogram', () => {
      const histogram = meter.createHistogram('name');
      assert.ok(histogram instanceof Metric);
    });

    it('should create a histogram with options', () => {
      const histogram = meter.createHistogram('name', {
        description: 'desc',
        unit: '1',
        disabled: false,
      });
      assert.ok(histogram instanceof Metric);
    });

    it('should set histogram boundaries for histogram', async () => {
      const histogram = meter.createHistogram('name', {
        description: 'desc',
        unit: '1',
        disabled: false,
        boundaries: [10, 20, 30, 100],
      }) as HistogramMetric;

      histogram.record(10);
      histogram.record(30);
      histogram.record(50);
      histogram.record(200);

      await meter.collect();
      const [record] = meter.getProcessor().checkPointSet();
      assert.deepStrictEqual(record.aggregator.toPoint().value as Histogram, {
        buckets: {
          boundaries: [10, 20, 30, 100],
          counts: [0, 1, 0, 2, 1],
        },
        count: 4,
        sum: 290,
      });

      assert.ok(histogram instanceof Metric);
    });

    it('should pipe through resource', async () => {
      const histogram = meter.createHistogram(
        'name'
      ) as HistogramMetric;
      assert.ok(histogram.resource instanceof Resource);

      histogram.record(1, { foo: 'bar' });

      const [record] = await histogram.getMetricRecord();
      assert.ok(record.resource instanceof Resource);
    });

    it('should pipe through instrumentation library', async () => {
      const histogram = meter.createHistogram(
        'name'
      ) as HistogramMetric;
      assert.ok(histogram.instrumentationLibrary);

      histogram.record(1, { foo: 'bar' });

      const [record] = await histogram.getMetricRecord();
      const { name, version } = record.instrumentationLibrary;
      assert.strictEqual(name, 'test-meter');
      assert.strictEqual(version, undefined);
    });

    describe('names', () => {
      it('should return no op metric if name is an empty string', () => {
        const histogram = meter.createHistogram('');
        assert.ok(histogram instanceof api.NoopMetric);
      });

      it('should return no op metric if name does not start with a letter', () => {
        const histogram1 = meter.createHistogram('1name');
        const histogram_ = meter.createHistogram('_name');
        assert.ok(histogram1 instanceof api.NoopMetric);
        assert.ok(histogram_ instanceof api.NoopMetric);
      });

      it('should return no op metric if name is an empty string contain only letters, numbers, ".", "_", and "-"', () => {
        const histogram = meter.createHistogram(
          'name with invalid characters^&*('
        );
        assert.ok(histogram instanceof api.NoopMetric);
      });
    });

    describe('.bind()', () => {
      const performanceTimeOrigin = hrTime();

      it('should create a histogram instrument', () => {
        const histogram = meter.createHistogram(
          'name'
        ) as HistogramMetric;
        const boundHistogram = histogram.bind(attributes);
        assert.doesNotThrow(() => boundHistogram.record(10));
      });

      it('should not set the instrument data when disabled', async () => {
        const histogram = meter.createHistogram('name', {
          disabled: true,
        }) as HistogramMetric;
        const boundHistogram = histogram.bind(attributes);
        boundHistogram.record(10);

        await meter.collect();
        const [record1] = meter.getProcessor().checkPointSet();
        assert.deepStrictEqual(
          record1.aggregator.toPoint().value as Histogram,
          {
            buckets: {
              boundaries: [Infinity],
              counts: [0, 0],
            },
            count: 0,
            sum: 0,
          }
        );
      });

      it('should accept negative (and positive) values', async () => {
        const histogram = meter.createHistogram('name') as HistogramMetric;
        const boundHistogram = histogram.bind(attributes);
        boundHistogram.record(-10);
        boundHistogram.record(50);

        await meter.collect();
        const [record1] = meter.getProcessor().checkPointSet();
        assert.deepStrictEqual(
          record1.aggregator.toPoint().value as Histogram,
          {
            buckets: {
              boundaries: [Infinity],
              counts: [2, 0],
            },
            count: 2,
            sum: 40,
          }
        );
        assert.ok(
          hrTimeToNanoseconds(record1.aggregator.toPoint().timestamp) >
            hrTimeToNanoseconds(performanceTimeOrigin)
        );
      });

      it('should return same instrument on same attribute values', async () => {
        const histogram = meter.createHistogram(
          'name'
        ) as HistogramMetric;
        const boundHistogram1 = histogram.bind(attributes);
        boundHistogram1.record(10);
        const boundHistogram2 = histogram.bind(attributes);
        boundHistogram2.record(100);
        await meter.collect();
        const [record1] = meter.getProcessor().checkPointSet();
        assert.deepStrictEqual(
          record1.aggregator.toPoint().value as Histogram,
          {
            buckets: {
              boundaries: [Infinity],
              counts: [2, 0],
            },
            count: 2,
            sum: 110,
          }
        );
        assert.strictEqual(boundHistogram1, boundHistogram2);
      });

      it('should ignore non-number values', async () => {
        const histogram = meter.createHistogram(
          'name'
        ) as HistogramMetric;
        const boundHistogram = histogram.bind(attributes);

        await Promise.all(
          nonNumberValues.map(async val => {
            // @ts-expect-error verify non number types
            boundHistogram.record(val);
            await meter.collect();
            const [record1] = meter.getProcessor().checkPointSet();
            assert.deepStrictEqual(
              record1.aggregator.toPoint().value as Histogram,
              {
                buckets: {
                  boundaries: [Infinity],
                  counts: [0, 0],
                },
                count: 0,
                sum: 0,
              }
            );
          })
        );
      });
    });

    describe('.unbind()', () => {
      it('should remove the histogram instrument', () => {
        const histogram = meter.createHistogram(
          'name'
        ) as HistogramMetric;
        const boundHistogram = histogram.bind(attributes);
        assert.strictEqual(histogram['_instruments'].size, 1);
        histogram.unbind(attributes);
        assert.strictEqual(histogram['_instruments'].size, 0);
        const boundHistogram2 = histogram.bind(attributes);
        assert.strictEqual(histogram['_instruments'].size, 1);
        assert.notStrictEqual(boundHistogram, boundHistogram2);
      });

      it('should not fail when removing non existing instrument', () => {
        const histogram = meter.createHistogram('name') as HistogramMetric;
        histogram.unbind({});
      });

      it('should clear all instruments', () => {
        const histogram = meter.createHistogram(
          'name'
        ) as HistogramMetric;
        histogram.bind(attributes);
        assert.strictEqual(histogram['_instruments'].size, 1);
        histogram.clear();
        assert.strictEqual(histogram['_instruments'].size, 0);
      });
    });
  });

  describe('#ObservableCounterMetric', () => {
    it('should create an ObservableCounter', () => {
      const observableCounter = meter.createObservableCounter('name') as ObservableCounterMetric;
      assert.ok(observableCounter instanceof Metric);
    });

    it('should return noop observable counter when name is invalid', () => {
      // Need to stub/spy on the underlying logger as the "diag" instance is global
      const spy = sinon.stub(diag, 'warn');
      const observableCounter = meter.createObservableCounter('na me');
      assert.ok(observableCounter === api.NOOP_OBSERVABLE_COUNTER_METRIC);
      const args = spy.args[0];
      assert.ok(
        args[0],
        'Invalid metric name na me. Defaulting to noop metric implementation.'
      );
    });

    it('should create observable counter with options', () => {
      const observableCounter = meter.createObservableCounter('name', {
        description: 'desc',
        unit: '1',
        disabled: false,
      }) as ObservableCounterMetric;
      assert.ok(observableCounter instanceof Metric);
    });

    it('should set callback and observe value ', async () => {
      let counter = 0;

      function getValue() {
        diag.info('getting value, counter:', counter);
        if (++counter % 2 === 0) {
          return 3;
        }
        return -1;
      }

      const observableCounter = meter.createObservableCounter(
        'name',
        {
          description: 'desc',
        },
        (observableResult: api.ObservableResult) => {
          // simulate async
          return new Promise<void>(resolve => {
            setTimeout(() => {
              observableResult.observe(getValue(), { pid: '123', core: '1' });
              resolve();
            }, 1);
          });
        }
      ) as ObservableCounterMetric;

      let metricRecords = await observableCounter.getMetricRecord();
      assert.strictEqual(metricRecords.length, 1);
      let point = metricRecords[0].aggregator.toPoint();
      assert.strictEqual(point.value, -1);
      assert.strictEqual(
        hashAttributes(metricRecords[0].attributes),
        '|#core:1,pid:123'
      );

      metricRecords = await observableCounter.getMetricRecord();
      assert.strictEqual(metricRecords.length, 1);
      point = metricRecords[0].aggregator.toPoint();
      assert.strictEqual(point.value, 3);

      metricRecords = await observableCounter.getMetricRecord();
      assert.strictEqual(metricRecords.length, 1);
      point = metricRecords[0].aggregator.toPoint();
      assert.strictEqual(point.value, 3);
    });

    it('should set callback and observe value when callback returns nothing', async () => {
      const observableCounter = meter.createObservableCounter(
        'name',
        {
          description: 'desc',
        },
        (observableResult: api.ObservableResult) => {
          observableResult.observe(1, { pid: '123', core: '1' });
        }
      ) as ObservableCounterMetric;

      const metricRecords = await observableCounter.getMetricRecord();
      assert.strictEqual(metricRecords.length, 1);
    });

    it(
      'should set callback and observe value when callback returns anything' +
        ' but Promise',
      async () => {
        const observableCounter = meter.createObservableCounter(
          'name',
          {
            description: 'desc',
          },
          (observableResult: api.ObservableResult) => {
            observableResult.observe(1, { pid: '123', core: '1' });
            return '1';
          }
        ) as ObservableCounterMetric;

        const metricRecords = await observableCounter.getMetricRecord();
        assert.strictEqual(metricRecords.length, 1);
      }
    );

    it('should reject getMetricRecord when callback throws an error', async () => {
      const observableCounter = meter.createObservableCounter(
        'name',
        {
          description: 'desc',
        },
        (observableResult: api.ObservableResult) => {
          observableResult.observe(1, { pid: '123', core: '1' });
          throw new Error('Boom');
        }
      ) as ObservableCounterMetric;
      await observableCounter
        .getMetricRecord()
        .then()
        .catch(e => {
          assert.strictEqual(e.message, 'Boom');
        });
    });

    it('should pipe through resource', async () => {
      const observableCounter = meter.createObservableCounter('name', {}, result => {
        result.observe(42, { foo: 'bar' });
        return Promise.resolve();
      }) as ObservableCounterMetric;
      assert.ok(observableCounter.resource instanceof Resource);

      const [record] = await observableCounter.getMetricRecord();
      assert.ok(record.resource instanceof Resource);
    });
  });

  describe('#ObservableGauge', () => {
    it('should create an observable gauge', () => {
      const observableGauge = meter.createObservableGauge(
        'name'
      ) as ObservableGaugeMetric;
      assert.ok(observableGauge instanceof Metric);
    });

    it('should return noop observable gauge when name is invalid', () => {
      // Need to stub/spy on the underlying logger as the "diag" instance is global
      const spy = sinon.stub(diag, 'warn');
      const observableGauge = meter.createObservableGauge('na me');
      assert.ok(observableGauge === api.NOOP_OBSERVABLE_GAUGE_METRIC);
      const args = spy.args[0];
      assert.ok(
        args[0],
        'Invalid metric name na me. Defaulting to noop metric implementation.'
      );
    });

    it('should create observable gauge with options', () => {
      const observableGauge = meter.createObservableGauge('name', {
        description: 'desc',
        unit: '1',
        disabled: false,
      }) as ObservableGaugeMetric;
      assert.ok(observableGauge instanceof Metric);
    });

    it('should set callback and observe value ', async () => {
      const observableGauge = meter.createObservableGauge(
        'name',
        {
          description: 'desc',
        },
        (observableResult: api.ObservableResult) => {
          // simulate async
          return new Promise<void>(resolve => {
            setTimeout(() => {
              observableResult.observe(getCpuUsage(), { pid: '123', core: '1' });
              observableResult.observe(getCpuUsage(), { pid: '123', core: '2' });
              observableResult.observe(getCpuUsage(), { pid: '123', core: '3' });
              observableResult.observe(getCpuUsage(), { pid: '123', core: '4' });
              resolve();
            }, 1);
          });
        }
      ) as ObservableGaugeMetric;

      function getCpuUsage() {
        return Math.random();
      }

      const metricRecords: MetricRecord[] = await observableGauge.getMetricRecord();
      assert.strictEqual(metricRecords.length, 4);

      const metric1 = metricRecords[0];
      const metric2 = metricRecords[1];
      const metric3 = metricRecords[2];
      const metric4 = metricRecords[3];
      assert.strictEqual(hashAttributes(metric1.attributes), '|#core:1,pid:123');
      assert.strictEqual(hashAttributes(metric2.attributes), '|#core:2,pid:123');
      assert.strictEqual(hashAttributes(metric3.attributes), '|#core:3,pid:123');
      assert.strictEqual(hashAttributes(metric4.attributes), '|#core:4,pid:123');

      ensureMetric(metric1);
      ensureMetric(metric2);
      ensureMetric(metric3);
      ensureMetric(metric4);
    });

    it('should pipe through resource', async () => {
      const observableGauge = meter.createObservableGauge('name', {}, result => {
        result.observe(42, { foo: 'bar' });
      }) as ObservableGaugeMetric;
      assert.ok(observableGauge.resource instanceof Resource);

      const [record] = await observableGauge.getMetricRecord();
      assert.ok(record.resource instanceof Resource);
    });
  });

  describe('#ObservableUpDownCounterMetric', () => {
    it('should create an ObservableUpDownCounter', () => {
      const observableUpDownCounter = meter.createObservableUpDownCounter(
        'name'
      ) as ObservableUpDownCounterMetric;
      assert.ok(observableUpDownCounter instanceof Metric);
    });

    it('should return noop observable up down counter when name is invalid', () => {
      // Need to stub/spy on the underlying logger as the "diag" instance is global
      const spy = sinon.stub(diag, 'warn');
      const observableUpDownCounter = meter.createObservableUpDownCounter('na me');
      assert.ok(observableUpDownCounter === api.NOOP_OBSERVABLE_UP_DOWN_COUNTER_METRIC);
      const args = spy.args[0];
      assert.ok(
        args[0],
        'Invalid metric name na me. Defaulting to noop metric implementation.'
      );
    });

    it('should create observable up down counter with options', () => {
      const observableUpDownCounter = meter.createObservableUpDownCounter('name', {
        description: 'desc',
        unit: '1',
        disabled: false,
      }) as ObservableUpDownCounterMetric;
      assert.ok(observableUpDownCounter instanceof Metric);
    });

    it('should set callback and observe value ', async () => {
      let counter = 0;

      function getValue() {
        counter++;
        if (counter % 2 === 0) {
          return 2;
        }
        return 3;
      }

      const observableUpDownCounter = meter.createObservableUpDownCounter(
        'name',
        {
          description: 'desc',
        },
        (observableResult: api.ObservableResult) => {
          // simulate async
          return new Promise<void>(resolve => {
            setTimeout(() => {
              observableResult.observe(getValue(), { pid: '123', core: '1' });
              resolve();
            }, 1);
          });
        }
      ) as ObservableUpDownCounterMetric;

      let metricRecords = await observableUpDownCounter.getMetricRecord();
      assert.strictEqual(metricRecords.length, 1);
      let point = metricRecords[0].aggregator.toPoint();
      assert.strictEqual(point.value, 3);
      assert.strictEqual(
        hashAttributes(metricRecords[0].attributes),
        '|#core:1,pid:123'
      );

      metricRecords = await observableUpDownCounter.getMetricRecord();
      assert.strictEqual(metricRecords.length, 1);
      point = metricRecords[0].aggregator.toPoint();
      assert.strictEqual(point.value, 2);

      metricRecords = await observableUpDownCounter.getMetricRecord();
      assert.strictEqual(metricRecords.length, 1);
      point = metricRecords[0].aggregator.toPoint();
      assert.strictEqual(point.value, 3);
    });

    it('should set callback and observe value when callback returns nothing', async () => {
      const observableUpDownCounter = meter.createObservableUpDownCounter(
        'name',
        {
          description: 'desc',
        },
        (observableResult: api.ObservableResult) => {
          observableResult.observe(1, { pid: '123', core: '1' });
        }
      ) as ObservableUpDownCounterMetric;

      const metricRecords = await observableUpDownCounter.getMetricRecord();
      assert.strictEqual(metricRecords.length, 1);
    });

    it(
      'should set callback and observe value when callback returns anything' +
        ' but Promise',
      async () => {
        const observableUpDownCounter = meter.createObservableUpDownCounter(
          'name',
          {
            description: 'desc',
          },
          (observableResult: api.ObservableResult) => {
            observableResult.observe(1, { pid: '123', core: '1' });
            return '1';
          }
        ) as ObservableUpDownCounterMetric;

        const metricRecords = await observableUpDownCounter.getMetricRecord();
        assert.strictEqual(metricRecords.length, 1);
      }
    );

    it('should reject getMetricRecord when callback throws an error', async () => {
      const observableUpDownCounter = meter.createObservableUpDownCounter(
        'name',
        {
          description: 'desc',
        },
        (observableResult: api.ObservableResult) => {
          observableResult.observe(1, { pid: '123', core: '1' });
          throw new Error('Boom');
        }
      ) as ObservableUpDownCounterMetric;
      await observableUpDownCounter
        .getMetricRecord()
        .then()
        .catch(e => {
          assert.strictEqual(e.message, 'Boom');
        });
    });

    it('should pipe through resource', async () => {
      const observableUpDownCounter = meter.createObservableUpDownCounter(
        'name',
        {},
        result => {
          result.observe(42, { foo: 'bar' });
          return Promise.resolve();
        }
      ) as ObservableUpDownCounterMetric;
      assert.ok(observableUpDownCounter.resource instanceof Resource);

      const [record] = await observableUpDownCounter.getMetricRecord();
      assert.ok(record.resource instanceof Resource);
    });
  });

  describe('#getMetrics', () => {
    it('should create a DOUBLE counter', async () => {
      const key = 'key';
      const counter = meter.createCounter('counter', {
        description: 'test',
      }) as CounterMetric;
      const attributes = { [key]: 'counter-value' };
      const boundCounter = counter.bind(attributes);
      boundCounter.add(10.45);

      await meter.collect();
      const record = meter.getProcessor().checkPointSet();

      assert.strictEqual(record.length, 1);
      assert.deepStrictEqual(record[0].descriptor, {
        name: 'counter',
        description: 'test',
        metricKind: MetricKind.COUNTER,
        unit: '1',
        valueType: api.ValueType.DOUBLE,
      });
      assert.strictEqual(record[0].attributes, attributes);
      const value = record[0].aggregator.toPoint().value as Sum;
      assert.strictEqual(value, 10.45);
    });

    it('should create an INT counter', async () => {
      const key = 'key';
      const counter = meter.createCounter('counter', {
        description: 'test',
        valueType: api.ValueType.INT,
      }) as CounterMetric;
      const attributes = { [key]: 'counter-value' };
      const boundCounter = counter.bind(attributes);
      boundCounter.add(10.45);

      await meter.collect();
      const record = meter.getProcessor().checkPointSet();

      assert.strictEqual(record.length, 1);
      assert.deepStrictEqual(record[0].descriptor, {
        name: 'counter',
        description: 'test',
        metricKind: MetricKind.COUNTER,
        unit: '1',
        valueType: api.ValueType.INT,
      });
      assert.strictEqual(record[0].attributes, attributes);
      const value = record[0].aggregator.toPoint().value as Sum;
      assert.strictEqual(value, 10);
    });
  });
});

function ensureMetric(metric: MetricRecord, name?: string, value?: LastValue) {
  assert.ok(metric.aggregator instanceof LastValueAggregator);
  const lastValue = metric.aggregator.toPoint().value;
  if (value) {
    assert.deepStrictEqual(lastValue, value);
  }
  const descriptor = metric.descriptor;
  assert.strictEqual(descriptor.name, name || 'name');
  assert.strictEqual(descriptor.description, 'desc');
  assert.strictEqual(descriptor.unit, '1');
  assert.strictEqual(descriptor.metricKind, MetricKind.OBSERVABLE_GAUGE);
  assert.strictEqual(descriptor.valueType, api.ValueType.DOUBLE);
}
