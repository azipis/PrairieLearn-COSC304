const ERR = require('async-stacktrace');
const fs = require('fs-extra');
const async = require('async');
const tmp = require('tmp');
const Docker = require('dockerode');
const AWS = require('aws-sdk');
const { exec } = require('child_process');
const path = require('path');
const request = require('request');
const byline = require('byline');

const globalLogger = require('./lib/logger');
const jobLogger = require('./lib/jobLogger');
const configManager = require('./lib/config');
const config = require('./lib/config').config;
const receiveFromQueue = require('./lib/receiveFromQueue');
const util = require('./lib/util');
const load = require('./lib/load');
const sqldb = require('./lib/sqldb');

async.series([
    (callback) => {
        configManager.loadConfig((err) => {
            if (ERR(err, callback)) return;
            globalLogger.info('Config loaded:');
            globalLogger.info(JSON.stringify(config, null, 2));
            callback(null);
        });
    },
    (callback) => {
        if (!config.reportLoad) return callback(null);
        var pgConfig = {
            host: config.postgresqlHost,
            database: config.postgresqlDatabase,
            user: config.postgresqlUser,
            password: config.postgresqlPassword,
            max: 2,
            idleTimeoutMillis: 30000,
        };
        globalLogger.info('Connecting to database ' + pgConfig.user + '@' + pgConfig.host + ':' + pgConfig.database);
        var idleErrorHandler = function(err) {
            globalLogger.error('idle client error', err);
        };
        sqldb.init(pgConfig, idleErrorHandler, function(err) {
            if (ERR(err, callback)) return;
            globalLogger.info('Successfully connected to database');
            callback(null);
        });
    },
    (callback) => {
        if (!config.reportLoad) return callback(null);
        const maxJobs = 1;
        load.init(maxJobs);
        callback(null);
    },
    () => {
        globalLogger.info('Initialization complete; beginning to process jobs');
        const sqs = new AWS.SQS();
        async.forever((next) => {
            receiveFromQueue(sqs, config.queueUrl, (job, fail, success) => {
                handleJob(job, (err) => {
                    if (ERR(err, fail)) return;
                    success();
                });
            }, (err) => {
                if (ERR(err, (err) => globalLogger.error(err)));
                next();
            });
        });
    }
], (err) => {
    globalLogger.error(String(err));
    process.exit(1);
});

function handleJob(job, done) {
    load.startJob();
    const receivedTime = new Date().toISOString();

    const loggerOptions = {
        bucket: job.s3Bucket,
        rootKey: job.s3RootKey
    };

    const logger = jobLogger(loggerOptions);
    globalLogger.info(`Logging job ${job.jobId} to S3: ${job.s3Bucket}/${job.s3RootKey}`);

    const context = {
        docker: new Docker(),
        s3: new AWS.S3(),
        receivedTime,
        logger,
        job
    };

    logger.info(`Running job ${job.jobId}!`);
    logger.info(job);

    async.auto({
        context: (callback) => callback(null, context),
        initDocker: ['context', initDocker],
        initFiles: ['context', initFiles],
        runJob: ['initDocker', 'initFiles', runJob],
        uploadResults: ['runJob', uploadResults],
        uploadArchive: ['runJob', uploadArchive],
        cleanup: ['uploadResults', 'uploadArchive', function(results, callback) {
            logger.info('Removing temporary directories');
            results.initFiles.tempDirCleanup();
            callback(null);
        }]
    }, (err) => {
        load.endJob();
        if (ERR(err, done)) return;
        done(null);
    });
}

function initDocker(info, callback) {
    const {
        context: {
            logger,
            docker,
            job: {
                image
            }
        }
    } = info;

    async.series([
        (callback) => {
            logger.info('Pinging docker');
            docker.ping((err) => {
                if (ERR(err, callback)) return;
                callback(null);
            });
        },
        (callback) => {
            logger.info(`Pulling latest version of "${image}" image`);
            const repository = util.parseRepositoryTag(image);
            const params = {
                fromImage: repository.repository,
                tag: repository.tag || 'latest'
            };

            docker.createImage(params, (err, stream) => {
                if (err) {
                    logger.warn(`Error pulling "${image}" image; attempting to fall back to cached version`);
                    logger.warn(err);
                }

                docker.modem.followProgress(stream, (err) => {
                    if (ERR(err, callback)) return;
                    callback(null);
                }, (output) => {
                    logger.info(output);
                });
            });
        },
    ], (err) => {
        if (ERR(err, callback)) return;
        callback(null);
    });
}

function initFiles(info, callback) {
    const {
        context: {
            logger,
            s3,
            job: {
                jobId,
                s3Bucket,
                s3RootKey,
                entrypoint
            }
        }
    } = info;

    let jobArchiveFile, jobArchiveFileCleanup;
    const files = {};

    async.series([
        (callback) => {
            logger.info('Setting up temp file');
            tmp.file((err, file, fd, cleanup) => {
                if (ERR(err, callback)) return;
                jobArchiveFile = file;
                jobArchiveFileCleanup = cleanup;
                callback(null);
            });
        },
        (callback) => {
            logger.info('Setting up temp dir');
            tmp.dir({
                prefix: `job_${jobId}_`,
                unsafeCleanup: true,
            }, (err, dir, cleanup) => {
                if (ERR(err, callback)) return;
                files.tempDir = dir;
                files.tempDirCleanup = cleanup;
                callback(null);
            });
        },
        (callback) => {
            logger.info('Loading job files');
            const params = {
                Bucket: s3Bucket,
                Key: `${s3RootKey}/job.tar.gz`
            };
            s3.getObject(params).createReadStream()
            .on('error', (err) => {
                return ERR(err, callback);
            }).on('end', () => {
                callback(null);
            }).pipe(fs.createWriteStream(jobArchiveFile));
        },
        (callback) => {
            logger.info('Unzipping files');
            exec(`tar -xf ${jobArchiveFile} -C ${files.tempDir}`, (err) => {
                if (ERR(err, callback)) return;
                jobArchiveFileCleanup();
                callback(null);
            });
        },
        (callback) => {
            logger.info('Making entrypoint executable');
            exec(`chmod +x ${path.join(files.tempDir, entrypoint.slice(6))}`, (err) => {
                if (err) {
                    logger.error('Could not make file executable; continuing execution anyways');
                }
                callback(null);
            });
        }
    ], (err) => {
        if (ERR(err, callback)) return;
        callback(null, files);
    });
}

function runJob(info, callback) {
    const {
        context: {
            docker,
            logger,
            receivedTime,
            job: {
                jobId,
                image,
                entrypoint,
                timeout
            }
        },
        initFiles: {
            tempDir
        }
    } = info;

    let results = {};
    let jobTimeout = timeout || 30;

    logger.info('Launching Docker container to run grading job');

    async.waterfall([
        (callback) => {
            docker.createContainer({
                Image: image,
                AttachStdout: true,
                AttachStderr: true,
                Tty: true,
                NetworkDisabled: true,
                HostConfig: {
                    Binds: [
                        `${tempDir}:/grade`
                    ],
                    Memory: 1 << 30, // 1 GiB
                    MemorySwap: 1 << 30, // same as Memory, so no access to swap
                    KernelMemory: 1 << 29, // 512 MiB
                    DiskQuota: 1 << 30, // 1 GiB
                    IpcMode: 'private',
                    CpuPeriod: 100000, // microseconds
                    CpuQuota: 90000, // portion of the CpuPeriod for this container
                    PidsLimit: 1024,
                    NetworkMode: 'none',
                },
                Entrypoint: entrypoint.split(' ')
            }, (err, container) => {
                if (ERR(err, callback)) return;
                callback(null, container);
            });
        },
        (container, callback) => {
            container.attach({
                stream: true,
                stdout: true,
                stderr: true,
            }, (err, stream) => {
                if (ERR(err, callback)) return;
                const out = byline(stream);
                out.on('data', (line) => {
                    logger.info(`container> ${line.toString('utf8')}`);
                });
                callback(null, container);
            });
        },
        (container, callback) => {
            container.start((err) => {
                if (ERR(err, callback)) return;
                logger.info('Container started!');
                results.start_time = new Date().toISOString();
                callback(null, container);
            });
        },
        (container, callback) => {
            const timeoutId = setTimeout(() => {
                results.timedOut = true;
                container.kill();
            }, jobTimeout * 1000);
            logger.info('Waiting for container to complete');
            container.wait((err) => {
                clearTimeout(timeoutId);
                if (ERR(err, callback)) return;
                results.end_time = new Date().toISOString();
                callback(null, container);
            });
        },
        (container, callback) => {
            container.inspect((err, data) => {
                if (ERR(err, callback)) return;
                if (results.timedOut) {
                    logger.info('Container timed out');
                } else {
                    logger.info(`Container exited with exit code ${data.State.ExitCode}`);
                }
                results.succeeded = (!results.timedOut && data.State.ExitCode == 0);
                callback(null, container);
            });
        },
        (container, callback) => {
            container.remove((err) => {
                if (ERR(err, callback)) return;
                callback(null);
            });
        },
        (callback) => {
            logger.info('Reading course results');
            // Now that the job has completed, let's extract the results
            // First up: results.json
            if (results.succeeded) {
                fs.readFile(path.join(tempDir, 'results', 'results.json'), (err, data) => {
                    if (err) {
                        logger.error('Could not read results.json');
                        results.succeeded = false;
                        results.message = 'Could not read grading results.';
                    } else {
                        if (Buffer.byteLength(data) > 100 * 1024) {
                            // Cap output at 100 KiB
                            results.succeeded = false;
                            results.message = 'The grading results were larger than 100 KiB. ' +
                            'Try removing print statements from your code to reduce the output size. ' +
                            'If the problem persists, please contact course staff or a proctor.';
                            return callback(null);
                        }

                        try {
                            results.results = JSON.parse(data);
                            results.succeeded = true;
                        } catch (e) {
                            logger.error('Could not parse results.json');
                            logger.error(e);
                            results.succeeded = false;
                            results.message = 'Could not parse the grading results.';
                        }

                        callback(null);
                    }
                });
            } else {
                if (results.timedOut) {
                    results.message = `Grading timed out after ${timeout} seconds.`;
                }
                results.results = null;
                callback(null);
            }
        }
    ], (err) => {
        if (ERR(err, (err) => logger.error(err)));

        results.job_id = jobId;
        results.received_time = receivedTime;

        if (err) {
            results.succeeded = false;
            results.message = err.toString();
            return callback(null, results);
        } else {
            return callback(null, results);
        }
    });
}

function uploadResults(info, callback) {
    const {
        context: {
            logger,
            s3,
            job: {
                jobId,
                s3Bucket,
                s3RootKey,
                webhookUrl,
                csrfToken
            }
        },
        runJob: results
    } = info;

    async.series([
        (callback) => {
            // Now we can send the results back to S3
            logger.info(`Uploading results.json to S3 bucket ${s3Bucket}/${s3RootKey}`);
            const params = {
                Bucket: s3Bucket,
                Key: `${s3RootKey}/results.json`,
                Body: new Buffer(JSON.stringify(results, null, '  '), 'binary')
            };
            s3.putObject(params, (err) => {
                if (ERR(err, callback)) return;
                callback(null);
            });
        },
        (callback) => {
            if (!webhookUrl) return callback(null);
            // Let's send the results back to PrairieLearn now; the archive will
            // be uploaded later
            logger.info('Pinging webhook with results');
            const webhookResults = {
                data: results,
                event: 'grading_result',
                job_id: jobId,
                __csrf_token: csrfToken,
            };
            request.post({method: 'POST', url: webhookUrl, json: true, body: webhookResults}, function (err, _response, _body) {
                if (ERR(err, callback)) return;
                callback(null);
            });
        }
    ], (err) => {
        if (ERR(err, callback)) return;
        callback(null);
    });
}

function uploadArchive(results, callback) {
    const {
        context: {
            logger,
            s3,
            job: {
                s3Bucket,
                s3RootKey
            }
        },
        initFiles: {
            tempDir
        }
    } = results;

    let tempArchive, tempArchiveCleanup;
    async.series([
        // Now we can upload the archive of the /grade directory
        (callback) => {
            logger.info('Creating temp file for archive');
            tmp.file((err, file, fd, cleanup) => {
                if (ERR(err, callback)) return;
                tempArchive = file;
                tempArchiveCleanup = cleanup;
                callback(null);
            });
        },
        (callback) => {
            logger.info('Building archive');
            exec(`tar -zcf ${tempArchive} ${tempDir}`, (err) => {
                if (ERR(err, callback)) return;
                callback(null);
            });
        },
        (callback) => {
            logger.info(`Uploading archive to s3 bucket ${s3Bucket}/${s3RootKey}`);
            const params = {
                Bucket: s3Bucket,
                Key: `${s3RootKey}/archive.tar.gz`,
                Body: fs.createReadStream(tempArchive)
            };
            s3.upload(params, (err) => {
                if (ERR(err, callback)) return;
                callback(null);
            });
        },
    ], (err) => {
        if (ERR(err, callback)) return;
        tempArchiveCleanup && tempArchiveCleanup();
        callback(null);
    });
}
