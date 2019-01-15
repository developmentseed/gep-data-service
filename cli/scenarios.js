const fs = require('fs-extra');
const path = require('path');
const csv = require('fast-csv');

const { userError } = require('./utils');

/**
 * Gets the scenario csvs from given directory
 *
 * @param {string} dirPath Path to the scenario directory
 *
 * @see userError()
 * @throws Error if there are no scenarios
 *
 * @return Scenario csv files
 */
async function getModelScenariosFromDir (dirPath) {
  const dir = await fs.readdir(dirPath);
  const csvs = dir.filter(f => f.endsWith('.csv'));

  if (!csvs.length) {
    throw userError(['No scenarios for this model were found.', ''], true);
  }

  return csvs;
}

/**
 * Validates the given scenario accoriding to the corresponding model
 *
 * @param {object} model The model
 * @param {string} filePath Path to the scenario
 *
 * @see userError()
 * @throws Error if validation fails
 *
 * @return boolean
 */
async function validateModelScenario (model, filePath) {
  const { name } = path.parse(filePath);

  const matchRes = name.match(/^([a-z0-9-]+)-([0-9](_[0-9]+)+)$/);
  if (!matchRes) {
    throw userError(['Malformed file name'], true);
  }

  const [, id, levers] = matchRes;

  if (id !== model.id) {
    throw userError(["Model id doesn't match model"], true);
  }

  if (levers.split('_').length !== model.levers.length) {
    throw userError(
      ['Filename levers count do not match model levers count'],
      true
    );
  }

  const elecCodes = model.timesteps
    ? model.timesteps.map(t => `FinalElecCode${t}`)
    : ['FinalElecCode'];

  await new Promise((resolve, reject) => {
    let line = 2;
    let errors = [];
    csv
      .fromPath(filePath, { headers: true, delimiter: ',' })
      .on('data', record => {
        elecCodes.forEach(c => {
          const v = record[c];
          if (v === '' || v === 99 || v === '99' || v === undefined) {
            const printVal = v === '' ? 'empty' : v;
            errors.push(`Found ${printVal} value for ${c} at line ${line}`);
          }
        });
        line++;
      })
      .on('end', () => {
        if (errors.length) {
          return reject(userError(errors, true));
        }
        resolve();
      })
      .on('error', reject);
  });

  return true;
}

/**
 * Prepares the scenario data for database insertion
 *
 * @param {object} model The model
 * @param {string} scenarioFilePath Path to the scenario
 *
 * @return array with scenario records
 */
async function prepareScenarioRecords (model, scenarioFilePath) {
  const { name: scenarioId } = path.parse(scenarioFilePath);

  const modelId = model.id;

  const timesteps = model.timesteps || [];

  const getFilterValueFromRecord = (record, filter, key) => {
    if (filter.type === 'range') {
      return parseFloat(record[key]);
    } else {
      return record[key];
    }
  };

  // Filter values to get depend on the model's timesteps, if available.
  const filtersWithTimestepKeys = model.filters.reduce((acc, filter) => {
    if (filter.timestep && timesteps.length) {
      return acc.concat(
        timesteps.map(year => ({
          ...filter,
          key: filter.key + year,
          _key: filter.key
        }))
      );
    } else {
      return acc.concat(filter);
    }
  }, []);

  // Calc summary value based on timesteps.
  const summaryKeys = [
    {
      key: 'FinalElecCode',
      parser: v => {
        v = parseInt(v);
        return v === 99 ? null : v;
      }
    },
    { key: 'InvestmentCost', parser: parseFloat },
    { key: 'NewCapacity', parser: parseFloat },
    { key: 'Pop', parser: parseFloat }
  ];

  const summaryWithTimestepKeys = summaryKeys.reduce((acc, summ) => {
    if (timesteps.length) {
      return acc.concat(
        timesteps.map(t => ({
          ...summ,
          key: summ.key + t,
          _key: summ.key
        }))
      );
    } else {
      return acc.concat(summ);
    }
  }, []);

  // Read CSV File
  return new Promise(function (resolve, reject) {
    const records = [];
    csv
      .fromPath(scenarioFilePath, { headers: true, delimiter: ',' })
      .on('data', record => {
        if (record.ID.indexOf('-') > -1) {
          record.ID = record.ID.split('-')[1];
        }

        // Prepare data for database.
        const entry = {
          modelId: modelId,
          scenarioId: scenarioId,
          featureId: parseInt(record.ID),
          summary: {},
          filterValues: {}
        };

        // Add summary.
        for (const { key, parser } of summaryWithTimestepKeys) {
          entry.summary[key] = parser(record[key]);
        }

        // Add filters.
        for (const filter of filtersWithTimestepKeys) {
          entry.filterValues[filter.key] = getFilterValueFromRecord(
            record,
            filter,
            filter.key
          );
        }

        records.push(entry);
      })
      .on('end', () => resolve(records))
      .on('error', reject);
  });
}

module.exports = {
  getModelScenariosFromDir,
  validateModelScenario,
  prepareScenarioRecords
};
