import {execFileSync} from 'child_process';
import {
  DBTResource,
  MetricService,
  QueryParams,
  Selectors,
} from './types/index.js';
import fs from 'fs';
import yaml from 'js-yaml';
import tempy from 'tempy';

interface DbtMetricService extends MetricService {
  installMetricsPackage: () => void;
  listMetrics: (name?: string, selectors?: Selectors) => DBTResource[];
  queryMetric: (params: QueryParams) => Record<string, string | number>;
}

export enum Warehouse {
  BIGQUERY = 'bigquery',
  POSTGRES = 'postgres',
  REDSHIFT = 'redshift',
  SNOWFLAKE = 'snowflake',
}

type Credentials = Record<string, string>;

interface BigqueryProfile {
  type: Warehouse.BIGQUERY;
  credentials: Credentials;
}

interface PostgresProfile {
  type: Warehouse.POSTGRES;
  credentials: Credentials;
}

interface RedshiftProfile {
  type: Warehouse.REDSHIFT;
  credentials: Credentials;
}

interface SnowflakeProfile {
  type: Warehouse.SNOWFLAKE;
  credentials: Credentials;
}

export type DbtProfile =
  | BigqueryProfile
  | PostgresProfile
  | RedshiftProfile
  | SnowflakeProfile;

interface PackageYaml {
  packages: Record<string, string>[];
}

export default class DbtLocalMetricService implements DbtMetricService {
  private dbtProjectPath: string;
  private dbtProfilePath?: string;
  private profile?: string;
  private credentials?: Record<string, string>;
  private target?: string;
  constructor(props: {
    dbtProjectPath?: string;
    target?: string;
    profile?: string;
    profileVariables?: DbtProfile;
  }) {
    const {dbtProjectPath, target, profile, profileVariables} = props;
    if (!dbtProjectPath) throw Error('no dbt project path given');
    this.dbtProjectPath = dbtProjectPath;
    this.target = target;
    this.credentials = profileVariables?.credentials;
    this.profile = profile;

    if (profileVariables) {
      this.profile = 'mapi_profile';
      this.target = 'prod';
      const {credentials, ...profileWithoutSecrets} = profileVariables;
      const envVar = (key: string) => `MAPI_DBT_PROFILE_${key.toUpperCase()}`;
      this.dbtProfilePath = tempy.directory({prefix: '_dbt_profile'});
      console.debug(
        `profileVariables found; beginning to write profile.yml to directory ${this.dbtProfilePath}`
      );
      const credentialsToWrite = Object.fromEntries(
        Object.keys(credentials).map(key => [
          key,
          `{{ env_var('${envVar(key)}') }}`,
        ])
      );
      const profileToWrite = {
        [this.profile]: {
          target: this.target,
          outputs: {
            [this.target]: {
              ...profileWithoutSecrets,
              ...(profileVariables.type === Warehouse.BIGQUERY &&
              credentials.method === 'service-account-json'
                ? {keyfileJson: credentialsToWrite}
                : credentialsToWrite),
            },
          },
        },
      };
      this.credentials = Object.fromEntries(
        Object.entries(credentials).map(([k, v]) => [envVar(k), v])
      );
      fs.writeFileSync(
        `${this.dbtProfilePath}/profiles.yml`,
        yaml.dump(profileToWrite)
      );
      console.debug('successfully wrote profile.yml');
    }
  }

  installMetricsPackage = () => {
    const PACKAGE_YAML_PATH = `${this.dbtProjectPath}/packages.yml`;
    const METRICS_API_PACKAGE = {
      git: 'https://github.com/mjirv/dbt-metrics-api.git',
      revision: 'main',
    };

    console.debug('called installMetricsPackage');

    const {packages} = yaml.load(
      fs.readFileSync(PACKAGE_YAML_PATH, 'utf-8')
    ) as PackageYaml;
    if (!packages?.find(el => el.git === METRICS_API_PACKAGE.git)) {
      console.debug('adding metrics package to packages.yml');
      packages.push(METRICS_API_PACKAGE);
      fs.writeFileSync(PACKAGE_YAML_PATH, yaml.dump({packages}));
    }

    try {
      execFileSync('dbt', ['deps'], {cwd: this.dbtProjectPath});
    } catch (error) {
      console.error(error);
      throw error;
    }
  };

  listMetrics = (name?: string, selectors: Selectors = {}) => {
    console.debug(
      `called listMetrics with params ${JSON.stringify({name, selectors})}`
    );
    const {type, model, package_name} = selectors;

    const select = name ? `metric:${name.replace(/"/g, '')}` : '';
    const res =
      '[' +
      execFileSync(
        'dbt',
        [
          'ls',
          ...(this.target ? ['--target', this.target] : []),
          ...(this.profile ? ['--profile', this.profile] : []),
          ...(this.dbtProfilePath ? ['--profiles-dir', this.dbtProfilePath] : []),
          ...(select ? ['--select', select] : []),
          '--resource-type',
          'metric',
          '--output',
          'json',
          '--output-keys',
          '"name model label description type time_grains dimensions filters unique_id package_name"',
        ],
        {
          cwd: this.dbtProjectPath,
          encoding: 'utf-8',
          env: {...process.env, ...this.credentials},
        }
      )
        .trimEnd()
        .match(/\{.*\}/g)
        ?.toString()
    +
      ']';

    let metrics = JSON.parse(res) as DBTResource[];
    if (type) {
      metrics = metrics.filter(metric => metric.type === type);
    }
    if (model) {
      metrics = metrics.filter(metric => metric.model === model);
    }
    if (package_name) {
      metrics = metrics.filter(metric => metric.package_name === package_name);
    }
    return metrics;
  };

  queryMetric = (params: QueryParams): Record<string, string | number> => {
    console.debug(`called queryMetric with params ${JSON.stringify(params)}`);
    const {
      metric_name,
      grain,
      dimensions,
      start_date,
      end_date,
      format = 'json',
    } = params;

    try {
      const raw_output = execFileSync(
        'dbt',
        [
          'run-operation',
          ...(this.target ? ['--target', this.target] : []),
          ...(this.profile ? ['--profile', this.profile] : []),
          ...(this.dbtProfilePath ? ['--profiles-dir', this.dbtProfilePath] : []),
          'dbt_metrics_api.run_metric',
          '--args',
          `${JSON.stringify({
            metric_name,
            grain,
            dimensions,
            start_date,
            end_date,
            format,
          })}`,
        ],
        {
          cwd: this.dbtProjectPath,
          encoding: 'utf-8',
          env: {...process.env, ...this.credentials},
        }
      ).toString();
      const BREAK_STRING = '<<<MAPI-BEGIN>>>\n';
      return JSON.parse(
        raw_output.slice(raw_output.indexOf(BREAK_STRING) + BREAK_STRING.length)
      );
    }
    catch (error) {
      console.error("An error occurred while querying a metric", error)
      throw new Error((error as { stdout: string }).stdout)
    }

  };
}
