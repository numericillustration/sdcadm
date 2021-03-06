/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2015, Joyent, Inc.
 */

/*
 * 'sdcadm post-setup underlay-nics'
 */

var p = console.log;
var util = require('util');

var assert = require('assert-plus');
var vasync = require('vasync');

var errors = require('../errors');


//---- internal support stuff

function UnderlayNics() {}
UnderlayNics.prototype.name = 'underlay-nics';

UnderlayNics.prototype.help = (
    'Provisions underlay NICs on the provided underlay network for the\n' +
    'given Compute Node(s).'
);

UnderlayNics.prototype.execute = function (opts, cb) {
    assert.object(opts, 'opts');
    assert.object(opts.sdcadm, 'opts.sdcadm');
    assert.object(opts.log, 'opts.log');
    assert.func(opts.progress, 'opts.progress');
    assert.string(opts.net_uuid, 'opts.net_uuid');
    assert.optionalArrayOfString(opts.cns, 'opts.cns');

    var progress = opts.progress;
    var sdcadm = opts.sdcadm;
    var log = opts.log;

    var MIN_VALID_NAPI_VERSION = '20150312';
    var img;
    var cns = [];
    var cns2Update = [];
    // Used by sdcadm history:
    var changes = [];
    var hist;
    // Given we may have errors for some CNs, and not from some others, we
    // need to store errors and report at end:
    var errs = [];

    vasync.pipeline({funcs: [
        function getNapiVmImgs(_, next) {
            sdcadm.getImgsForSvcVms({
                svc: 'napi'
            }, function (err, obj) {
                if (err) {
                    return next(err);
                }
                img = obj.imgs[0];
                return next();
            });
        },

        function checkMinNapiVersion(_, next) {
            progress('Checking for minimum NAPI version');
            var splitVersion = img.version.split('-');
            var validNapi = false;

            if (splitVersion[0] === 'master') {
                validNapi = splitVersion[1].substr(0, 8) >=
                    MIN_VALID_NAPI_VERSION;
            } else if (splitVersion[0] === 'release') {
                validNapi = splitVersion[1] >= MIN_VALID_NAPI_VERSION;
            }

            if (!validNapi) {
                return next(new errors.ValidationError(new Error('Datacenter ' +
                    'does not have the minimum NAPI version needed for adding' +
                    ' underlay nics to CNs. ' +
                    'Please try again after upgrading NAPI')));
            }

            return next();
        },

        function validateNetwork(_, next) {
            progress('Verifying the provided network exists');
            sdcadm.napi.getNetwork(opts.net_uuid, function (err, net) {
                if (err) {
                    if (err.statusCode === 404) {
                        return next(new errors.UsageError('The provided ' +
                                    'network UUID cannot be found in NAPI'));
                    } else {
                        return next(new errors.SDCClientError(err, 'napi'));
                    }
                }
                return next();
            });
        },

        function validateServers(_, next) {
            progress('Verifying the provided Server(s) UUID(s)');
            sdcadm.cnapi.listServers({
                setup: true
            }, function (err, recs) {
                if (err) {
                    return next(new errors.SDCClientError(err, 'cnapi'));
                }
                var hostnames = {};
                recs.forEach(function (r) {
                    hostnames[r.hostname] = r.uuid;
                });
                // Translate hostnames to UUIDs when possible:
                opts.cns = opts.cns.map(function (cn) {
                    if (Object.keys(hostnames).indexOf(cn) !== -1) {
                        return hostnames[cn];
                    } else {
                        return cn;
                    }
                });

                var uuids = recs.map(function (r) {
                    return (r.uuid);
                });

                // Print a message if any of the provided CNs is not valid
                opts.cns.forEach(function (cn) {
                    if (uuids.indexOf(cn) === -1) {
                        progress('Skipping invalid CN ' + cn);
                    } else {
                        cns.push(cn);
                    }
                });
                next();
            });
        },

        function filterServersWithUnderlayNicOnTheSameNetwork(_, next) {
            function checkServerNics(cn, nextCn) {
                sdcadm.napi.listNics({
                    owner_uuid: sdcadm.config.ufds_admin_uuid,
                    belongs_to_uuid: cn,
                    belongs_to_type: 'server',
                    network_uuid: opts.net_uuid
                }, function (err, nics) {
                    if (err) {
                        errs.push(new errors.SDCClientError(err, 'napi'));
                        nextCn(err);
                    } else {
                        if (!nics.length) {
                            cns2Update.push(cn);
                            return nextCn();
                        }
                        var hasUnderlayNic = false;
                        nics.forEach(function (nic) {
                            if (nic.underlay) {
                                progress('Skipping CN %s (already has an ' +
                                        'underlay nic in network %s)',
                                        cn, opts.net_uuid);
                                hasUnderlayNic = true;
                            }
                        });
                        if (!hasUnderlayNic) {
                            cns2Update.push(cn);
                        }
                        return nextCn();
                    }
                });
            }
            var existsQueue = vasync.queue(checkServerNics, 5);
            existsQueue.once('end', next);
            existsQueue.push(cns);
            existsQueue.close();
        },

        // CNs must have the configured underlay network tag assigned to an
        // actual NIC in order to be able to add underlay-nic for the CN:
        function filterServersWithoutUnderlayNicTag(_, next) {
            var underlayTag = sdcadm.sdc.metadata.fabric_cfg.sdc_underlay_tag;
            var cnsToSkip = [];
            var theCns = cns2Update;
            cns2Update = [];

            function checkServerTags(cn, nextCn) {
                sdcadm.napi.listNics({
                    owner_uuid: sdcadm.config.ufds_admin_uuid,
                    belongs_to_uuid: cn,
                    belongs_to_type: 'server'
                }, function (err, nics) {
                    if (err) {
                        errs.push(new errors.SDCClientError(err, 'napi'));
                        cnsToSkip.push(cn);
                        nextCn(err);
                    } else {
                        nics = nics || [];
                        var hasUnderlayTag = false;

                        nics.forEach(function (nic) {
                            if (hasUnderlayTag) {
                                return;
                            }
                            var nicTagsProvided = nic.nic_tags_provided;
                            if (nicTagsProvided &&
                                nicTagsProvided.indexOf(underlayTag) !== -1) {
                                hasUnderlayTag = true;
                            }
                        });

                        if (hasUnderlayTag) {
                            cns2Update.push(cn);
                            return nextCn();
                        }

                        sdcadm.napi.listAggrs({
                            belongs_to_uuid: cn
                        }, function (aggrErr, aggrs) {
                            if (aggrErr) {
                                errs.push(new errors.SDCClientError(
                                            aggrErr, 'napi'));
                                cnsToSkip.push(cn);
                                nextCn(aggrErr);
                            } else {
                                aggrs = aggrs || [];
                                aggrs.forEach(function (aggr) {
                                    if (hasUnderlayTag) {
                                        return;
                                    }
                                    var aProv = aggr.nic_tags_provided;
                                    if (aProv &&
                                            aProv.indexOf(underlayTag) !== -1) {
                                        hasUnderlayTag = true;
                                    }
                                });

                                if (hasUnderlayTag) {
                                    cns2Update.push(cn);
                                } else {
                                    cnsToSkip.push(cn);
                                }
                            }
                        });

                        return nextCn();
                    }
                });
            }

            var existsQueue = vasync.queue(checkServerTags, 5);
            existsQueue.once('end', function () {
                if (cnsToSkip.length) {
                    progress('The following CNs do not have the configured');
                    progress('underlay network tag assigned to any NIC and');
                    progress('will be skipped:');
                    progress(cnsToSkip.join(','));
                }
                next();
            });
            existsQueue.push(theCns);
            existsQueue.close();
        },

        function saveChangesToHistory(_, next) {
            if (!cns2Update.length) {
                return next();
            }
            changes.push({
                service: {
                    name: 'napi'
                },
                type: 'underlay-nics',
                servers: cns,
                network: opts.net_uuid
            });

            sdcadm.history.saveHistory({
                changes: changes
            }, function (err, hst) {
                if (err) {
                    return next(err);
                }
                hist = hst;
                return next();
            });
        },

        function provisionNics(_, next) {
            if (!cns2Update.length) {
                return next();
            }
            function provisionUnderlayNic(cn, nextNic) {
                var route = util.format('/networks/%s/nics', opts.net_uuid);
                sdcadm.napi.post(route, {
                    owner_uuid: sdcadm.config.ufds_admin_uuid,
                    belongs_to_uuid: cn,
                    belongs_to_type: 'server',
                    underlay: true
                }, function (err, res) {
                    if (err) {
                        errs.push(new errors.SDCClientError(err, 'napi'));
                        return nextNic(err);
                    }
                    progress('Underlay NIC created for CN %s', cn);
                    nextNic();
                });
            }

            var nicsQueue = vasync.queue(provisionUnderlayNic, 5);
            nicsQueue.once('end', next);
            nicsQueue.push(cns);
            nicsQueue.close();
        }
    ]}, function (err) {
        if (errs.length) {
            err = new errors.MultiError(errs);
        }

        if (!hist) {
            log.debug('History not set for underlay-nics');
            return cb(err);
        }

        if (!cns2Update.length) {
            progress('All the provided CNs already had an underlay NIC' +
                    ' on the provided network');
            return cb(err);
        }

        if (err) {
            hist.error = err;
        }

        sdcadm.history.updateHistory(hist, function (err2) {
            if (err) {
                return cb(err);
            } else if (err2) {
                return cb(err2);
            } else {
                return cb();
            }
        });
    });
};


//---- CLI

function do_underlay_nics(subcmd, opts, args, cb) {
    if (opts.help) {
        this.do_help('help', {}, [subcmd], cb);
        return;
    }

    var net_uuid = args.shift();
    if (net_uuid === 'help') {
        return cb(new errors.UsageError(
            'Please use `sdcadm post-setup help underlay-nics` instead'));
    }
    var cns = args.length ? args : null;

    if (!net_uuid || !cns) {
        return cb(new errors.UsageError(
            'must specify network uuid and at least one server'));
    }

    var proc = new UnderlayNics();
    proc.execute({
        sdcadm: this.sdcadm,
        log: this.log.child({
            postSetup: 'underlay-nics'
        }, true),
        progress: this.progress,
        net_uuid: net_uuid,
        cns: cns
    }, cb);
}

do_underlay_nics.help = (
    UnderlayNics.prototype.help + '\n' +
    '\n' +
    'Usage:\n' +
    '     {{name}} underlay-nics NETWORK_UUID SERVER1 [SERVER2...]\n' +
    '\n' +
    'Note that this command can be re-run as many times as needed and it \n' +
    'will automatically take care of do not provision two underlay nics \n' +
    'into the same network for any CN.\n' +
    '\n' +
    '{{options}}'
);

do_underlay_nics.options = [
    {
        names: ['help', 'h'],
        type: 'bool',
        help: 'Show this help.'
    }
];


//---- exports

module.exports = {
    do_underlay_nics: do_underlay_nics
};
