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

import * as api from '@opentelemetry/api-metrics';
import { InstrumentationLibrary } from '@opentelemetry/core';
import { Resource } from '@opentelemetry/resources';
import { BoundCounter } from './BoundInstrument';
import { Processor } from './export/Processor';
import { MetricKind } from './export/types';
import { Metric } from './Metric';

/** This is a SDK implementation of Counter Metric. */
export class CounterMetric extends Metric<BoundCounter> implements api.Counter {
  constructor(
    name: string,
    options: api.MetricOptions,
    private readonly _processor: Processor,
    resource: Resource,
    instrumentationLibrary: InstrumentationLibrary
  ) {
    super(name, options, MetricKind.COUNTER, resource, instrumentationLibrary);
  }
  protected _makeInstrument(attributes: api.Attributes): BoundCounter {
    return new BoundCounter(
      attributes,
      this._disabled,
      this._valueType,
      this._processor.aggregatorFor(this._descriptor)
    );
  }

  /**
   * Adds the given value to the current value. Values cannot be negative.
   * @param value the value to add.
   * @param [attributes = {}] key-values pairs that are associated with a specific metric
   *     that you want to record.
   */
  add(value: number, attributes: api.Attributes = {}): void {
    this.bind(attributes).add(value);
  }
}
