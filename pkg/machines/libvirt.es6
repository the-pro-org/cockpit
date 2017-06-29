/*jshint esversion: 6 */
/*
 * This file is part of Cockpit.
 *
 * Copyright (C) 2016 Red Hat, Inc.
 *
 * Cockpit is free software; you can redistribute it and/or modify it
 * under the terms of the GNU Lesser General Public License as published by
 * the Free Software Foundation; either version 2.1 of the License, or
 * (at your option) any later version.
 *
 * Cockpit is distributed in the hope that it will be useful, but
 * WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the GNU
 * Lesser General Public License for more details.
 *
 * You should have received a copy of the GNU Lesser General Public License
 * along with Cockpit; If not, see <http://www.gnu.org/licenses/>.
 */

/*
 * Provider for Libvirt
 */
import cockpit from 'cockpit';
import $ from 'jquery';

import { updateOrAddVm,
    updateVm,
    getVm,
    getAllVms,
    delayPolling,
    undefineVm,
    vmActionFailed,
} from './actions.es6';

import { usagePollingEnabled } from './selectors.es6';
import {
    toKiloBytes,
    logDebug,
    rephraseUI,
    fileDownload,
} from './helpers.es6';

import VMS_CONFIG from './config.es6';

const _ = cockpit.gettext;

// --- compatibility hack
if (!String.prototype.startsWith) {
    String.prototype.startsWith = function (searchString, position) {
        position = position || 0;
        return this.substr(position, searchString.length) === searchString;
    };
}

// FIXME: store this in some better place?
var clientLibvirt = null;
var pManager = null;

let LIBVIRT_PROVIDER = {};
LIBVIRT_PROVIDER = {
    name: 'Libvirt',

    /**
     * Initialize the provider.
     * Arguments are used for reference only, they are actually not needed for this Libvirt provider.
     *
     * @param providerContext - see `getProviderContext()` in provider.es6
     * @returns {boolean} - true, if initialization succeeded; or Promise
     */
    init(providerContext) {
        // This is default provider - the Libvirt, so we do not need to use the providerContext param.
        // The method is here for reference only.
        return true; // or Promise
    },

    canReset: (vmState) => vmState == 'running' || vmState == 'idle' || vmState == 'paused',
    canShutdown: (vmState) => LIBVIRT_PROVIDER.canReset(vmState),
    canDelete: (vmState) => true,
    isRunning: (vmState) => LIBVIRT_PROVIDER.canReset(vmState),
    canRun: (vmState) => vmState == 'shutoff',
    canConsole: (vmState) => vmState == 'running',

    /**
     * Read VM properties of a single VM
     */
    GET_VM ({ lookupId: objPath, connectionName }) {
        logDebug(`${this.name}.GET_VM(${objPath}, ${connectionName})`);

        return dispatch => {
            let pDomain = clientLibvirt.proxy('org.libvirt.Domain', objPath);

            pDomain.wait(() => {
                pDomain.GetXMLDesc(0)
                .then(domXml => {
                    parseDumpxml(dispatch, connectionName, objPath, domXml);

                    let props = {connectionName, name: pDomain.Name, state: pDomain.State,
                                 persistent: pDomain.Persistent, autostart: pDomain.Autostart};
                    if (!LIBVIRT_PROVIDER.isRunning(pDomain.State)) // clean usage data
                        props.actualTimeInMs = -1;
                    logDebug(`${this.name}.GET_VM(${objPath}, ${connectionName}): update props ${JSON.stringify(props)}`);
                    dispatch(updateVm(props));
                });
            });
        }; // end of GET_VM return
    },

    /**
     * Initiate read of all VMs
     *
     * @returns {Function}
     */
    GET_ALL_VMS ({ connectionName }) {
        logDebug(`${this.name}.GET_ALL_VMS(connectionName='${connectionName}'):`);
        if (connectionName) {
            if (connectionName !== 'session') {
                console.warn("FIXME: this PoC only supports session libvirt");
                return cockpit.defer().resolve().promise;
            }

            return dispatch => {
                startEventMonitor(dispatch, connectionName);
                doGetAllVms(dispatch, connectionName);
            };
        }

        clientLibvirt = cockpit.dbus('org.libvirt', { bus: 'session' });
        pManager = clientLibvirt.proxy('org.libvirt.Manager', '/org/libvirt/Manager');

        return dispatch => { // for all connections
            return cockpit.user().done( loggedUser => {
                const promises = Object.getOwnPropertyNames(VMS_CONFIG.Virsh.connections)
                    .filter(
                        // The 'root' user does not have its own qemu:///session just qemu:///system
                        // https://bugzilla.redhat.com/show_bug.cgi?id=1045069
                        connectionName => canLoggedUserConnectSession(connectionName, loggedUser))
                    .map(connectionName => dispatch(getAllVms(connectionName)));

                return cockpit.all(promises);
            });
        };
    },

    SHUTDOWN_VM ({ name, connectionName, id: objPath }) {
        logDebug(`${this.name}.SHUTDOWN_VM(${name}, ${connectionName}, ${objPath}):`);
        return dispatch => {
            clientLibvirt.call(objPath, 'org.libvirt.Domain', 'Shutdown', null, {timeout: 30000})
                .fail(exception => dispatch(vmActionFailed(
                    { name, connectionName, message: _("VM SHUT DOWN action failed"), detail: {exception} }
                )));
        };
    },

    FORCEOFF_VM ({ name, connectionName, id: objPath }) {
        logDebug(`${this.name}.FORCEOFF_VM(${name}, ${connectionName}, ${objPath}):`);
        return dispatch => {
            clientLibvirt.call(objPath, 'org.libvirt.Domain', 'Destroy', null, {timeout: 30000})
                .fail(exception => dispatch(vmActionFailed(
                    { name, connectionName, message: _("VM FORCE OFF action failed"), detail: {exception} }
                )));
        };
    },

    REBOOT_VM ({ name, connectionName, id: objPath }) {
        logDebug(`${this.name}.REBOOT_VM(${name}, ${connectionName}, ${objPath}):`);
        return dispatch => {
            clientLibvirt.call(objPath, 'org.libvirt.Domain', 'Reboot', [ 0 ], {timeout: 30000})
                .fail(exception => dispatch(vmActionFailed(
                    { name, connectionName, message: _("VM REBOOT action failed"), detail: {exception} }
                )));
        };
    },

    FORCEREBOOT_VM ({ name, connectionName, id: objPath }) {
        logDebug(`${this.name}.FORCEREBOOT_VM(${name}, ${connectionName}, ${objPath}):`);
        return dispatch => {
            clientLibvirt.call(objPath, 'org.libvirt.Domain', 'Reset', [ 0 ], {timeout: 30000})
                .fail(exception => dispatch(vmActionFailed(
                    { name, connectionName, message: _("VM FORCE REBOOT action failed"), detail: {exception} }
                )));
        };
    },

    START_VM ({ name, connectionName, id: objPath }) {
        logDebug(`${this.name}.START_VM(${name}, ${connectionName}, ${objPath}):`);
        return dispatch => {
            clientLibvirt.call(objPath, 'org.libvirt.Domain', 'Create', null, {timeout: 30000})
                .fail(exception => dispatch(vmActionFailed(
                    { name, connectionName, message: _("VM START action failed"), detail: {exception} }
                )));
        };
    },

    DELETE_VM ({ name, connectionName, id: objPath, options }) {
        logDebug(`${this.name}.DELETE_VM(${name}, ${connectionName}, ${objPath}, ${JSON.stringify(options)}):`);

        function destroy() {
            return clientLibvirt.call(objPath, 'org.libvirt.Domain', 'Destroy', null, {timeout: 30000});
        }

        function undefine() {
            return clientLibvirt.call(objPath, 'org.libvirt.Domain', 'Undefine', null, {timeout: 30000});
        }

        return dispatch => {
            if (options.destroy) {
                return destroy().then(undefine);
            } else {
                return undefine();
            }
        };
    },

    USAGE_START_POLLING ({ name, connectionName, id: objPath }) {
        logDebug(`${this.name}.USAGE_START_POLLING(${name}):`);
        return (dispatch => {
            dispatch(updateVm({ connectionName, name, usagePolling: true}));
            dispatch(doUsagePolling(name, connectionName, objPath));
        });
    },

    USAGE_STOP_POLLING ({ name, connectionName }) {
        logDebug(`${this.name}.USAGE_STOP_POLLING(${name}):`);
        return dispatch => dispatch(updateVm({ connectionName, name, usagePolling: false}));
    },


    /**
     * Basic, but working.
     * TODO: provide support for more complex scenarios, like with TLS or proxy
     *
     * To try with virt-install: --graphics spice,listen=[external host IP]
     */
    CONSOLE_VM ({ name, consoleDetail }) {
        logDebug(`${this.name}.CONSOLE_VM(name='${name}'), detail = `, consoleDetail);
        return dispatch => {
            fileDownload({
                data: buildConsoleVVFile(consoleDetail),
                fileName: 'console.vv',
                mimeType: 'application/x-virt-viewer'
            });
        };
    },
};

function canLoggedUserConnectSession (connectionName, loggedUser) {
    return connectionName !== 'session' || loggedUser.name !== 'root';
}

function doGetAllVms (dispatch, connectionName) {
    pManager
        .wait(() => pManager.ListDomains(0)
            .done(objPaths => {
                logDebug(`GET_ALL_VMS: object paths: ${JSON.stringify(objPaths)}`);
                return cockpit.all(objPaths.map((path) => dispatch(getVm(connectionName, path))));
            })
            .fail(ex => console.warn("ListDomains failed:", ex)));
}

function parseDumpxml(dispatch, connectionName, objPath, domXml) {
    const xmlDoc = $.parseXML(domXml);

    if (!xmlDoc) {
        console.error(`Can't parse dumpxml, input: "${domXml}"`);
        return ;
    }

    const domainElem = xmlDoc.getElementsByTagName("domain")[0];
    const osElem = domainElem.getElementsByTagName("os")[0];
    const currentMemoryElem = domainElem.getElementsByTagName("currentMemory")[0];
    const vcpuElem = domainElem.getElementsByTagName("vcpu")[0];
    const cpuElem = domainElem.getElementsByTagName("cpu")[0];
    const vcpuCurrentAttr = vcpuElem.attributes.getNamedItem('current');
    const devicesElem = domainElem.getElementsByTagName("devices")[0];
    const osTypeElem = osElem.getElementsByTagName("type")[0];

    const name = domainElem.getElementsByTagName("name")[0].childNodes[0].nodeValue;
    const osType = osTypeElem.nodeValue;
    const emulatedMachine = osTypeElem.getAttribute("machine");

    const currentMemoryUnit = currentMemoryElem.getAttribute("unit");
    const currentMemory = toKiloBytes(currentMemoryElem.childNodes[0].nodeValue, currentMemoryUnit);

    const vcpus = (vcpuCurrentAttr && vcpuCurrentAttr.value) ? vcpuCurrentAttr.value : vcpuElem.childNodes[0].nodeValue;

    const disks = parseDumpxmlForDisks(devicesElem);
    const bootOrder = parseDumpxmlForBootOrder(osElem, devicesElem);
    const cpuModel = parseDumpxmlForCpuModel(cpuElem);
    const displays = parseDumpxmlForConsoles(devicesElem);

    dispatch(updateOrAddVm({
        connectionName, name, id: objPath,
        osType,
        currentMemory,
        vcpus,
        disks,
        emulatedMachine,
        cpuModel,
        bootOrder,
        displays,
    }));
}

function getSingleOptionalElem(parent, name) {
    const subElems = parent.getElementsByTagName(name);
    return subElems.length > 0 ? subElems[0] : undefined; // optional
}

function parseDumpxmlForDisks(devicesElem) {
    const disks = {};
    const diskElems = devicesElem.getElementsByTagName('disk');
    if (diskElems) {
        for (let i = 0; i < diskElems.length; i++) {
            const diskElem = diskElems[i];

            const targetElem = diskElem.getElementsByTagName('target')[0];

            const driverElem = getSingleOptionalElem(diskElem, 'driver');
            const sourceElem = getSingleOptionalElem(diskElem, 'source');
            const serialElem = getSingleOptionalElem(diskElem, 'serial');
            const aliasElem = getSingleOptionalElem(diskElem, 'alias');
            const readonlyElem = getSingleOptionalElem(diskElem, 'readonly');
            const bootElem = getSingleOptionalElem(diskElem, 'boot');

            const sourceHostElem = sourceElem ? getSingleOptionalElem(sourceElem, 'host') : undefined;

            const disk = { // see https://libvirt.org/formatdomain.html#elementsDisks
                target: targetElem.getAttribute('dev'), // identifier of the disk, i.e. sda, hdc
                driver: {
                    name: driverElem ? driverElem.getAttribute('name') : undefined, // optional
                    type: driverElem ? driverElem.getAttribute('type') : undefined,
                },
                bootOrder: bootElem ? bootElem.getAttribute('order') : undefined,
                type: diskElem.getAttribute('type'), // i.e.: file
                device: diskElem.getAttribute('device'), // i.e. cdrom, disk
                source: {
                    file: sourceElem ? sourceElem.getAttribute('file') : undefined, // optional file name of the disk
                    dev: sourceElem ? sourceElem.getAttribute('dev') : undefined,
                    pool: sourceElem ? sourceElem.getAttribute('pool') : undefined,
                    volume: sourceElem ? sourceElem.getAttribute('volumne') : undefined,
                    protocol: sourceElem ? sourceElem.getAttribute('protocol') : undefined,
                    host: {
                        name: sourceHostElem ? sourceHostElem.getAttribute('name') : undefined,
                        port: sourceHostElem ? sourceHostElem.getAttribute('port') : undefined,
                    },
                },
                bus: targetElem.getAttribute('bus'), // i.e. scsi, ide
                serial: serialElem ? serialElem.getAttribute('serial') : undefined, // optional serial number
                aliasName: aliasElem ? aliasElem.getAttribute('name') : undefined, // i.e. scsi0-0-0-0, ide0-1-0
                readonly: readonlyElem ? true : false,
            };

            if (disk.target) {
                disks[disk.target] = disk;
                logDebug(`parseDumpxmlForDisks(): disk device found: ${JSON.stringify(disk)}`);
            } else {
                console.error(`parseDumpxmlForDisks(): mandatory properties are missing in dumpxml, found: ${JSON.stringify(disk)}`);
            }
        }
    }

    return disks;
}

function getBootableDeviceType(device) {
    const tagName = device.tagName;
    let type = _("other");
    switch (tagName) {
        case 'disk':
            type = rephraseUI('bootableDisk', device.getAttribute('device')); // Example: disk, cdrom
            break;
        case 'interface':
            type = rephraseUI('bootableDisk', 'interface');
            break;
        default:
            console.info(`Unrecognized type of bootable device: ${tagName}`);
    }
    return type;
}

function parseDumpxmlForBootOrder(osElem, devicesElem) {
    const bootOrder = {
        devices: [],
    };

    // Prefer boot order defined in domain/os element
    const osBootElems = osElem.getElementsByTagName('boot');
    if (osBootElems.length > 0) {
        for (let bootNum = 0; bootNum < osBootElems.length; bootNum++) {
            const bootElem = osBootElems[bootNum];
            const dev = bootElem.getAttribute('dev');
            if (dev) {
                bootOrder.devices.push({
                    order: bootNum,
                    type: rephraseUI('bootableDisk', dev) // Example: hd, network, fd, cdrom
                });
            }
        }
        return bootOrder; // already sorted
    }

    // domain/os/boot elements not found, decide from device's boot elements
    // VM can be theoretically booted from any device.
    const bootableDevices = [];
    for (let devNum = 0; devNum < devicesElem.childNodes.length; devNum++) {
        const deviceElem = devicesElem.childNodes[devNum];
        if (deviceElem.nodeType === 1) { // XML elements only
            const bootElem = getSingleOptionalElem(deviceElem, 'boot');
            if (bootElem && bootElem.getAttribute('order')) {
                bootableDevices.push({
                    // so far just the 'type' is rendered, skipping redundant attributes
                    order: parseInt(bootElem.getAttribute('order')),
                    type: getBootableDeviceType(deviceElem),
                });
            }
        }
    }
    bootOrder.devices = bootableDevices.sort( (devA, devB) => devA.order - devB.order );
    return bootOrder;
}

function parseDumpxmlForCpuModel(cpuElem) {
    if (!cpuElem) {
        return undefined;
    }

    const cpuMode = cpuElem.getAttribute('mode');
    let cpuModel = '';
    if (cpuMode && cpuMode === 'custom') {
        const modelElem = getSingleOptionalElem(cpuElem, 'model');
        if (modelElem) {
            cpuModel = modelElem.childNodes[0].nodeValue; // content of the domain/cpu/model element
        }
    }

    return rephraseUI('cpuMode', cpuMode) + (cpuModel ? ` (${cpuModel})` : '');
}

function parseDumpxmlForConsoles(devicesElem) {
    const displays = {};
    const graphicsElems = devicesElem.getElementsByTagName("graphics");
    if (graphicsElems) {
        for (let i = 0; i < graphicsElems.length; i++) {
            const graphicsElem = graphicsElems[i];
            const display = {
                type: graphicsElem.getAttribute('type'),
                port: graphicsElem.getAttribute('port'),
                tlsPort: graphicsElem.getAttribute('tlsPort'),
                address: graphicsElem.getAttribute('listen'),
                autoport: graphicsElem.getAttribute('autoport'),
            };
            if (display.type &&
                (display.autoport ||
                (display.address && (display.port || display.tlsPort)) )) {
                displays[display.type] = display;
                logDebug(`parseDumpxmlForConsoles(): graphics device found: ${JSON.stringify(display)}`);
            } else {
                console.error(`parseDumpxmlForConsoles(): mandatory properties are missing in dumpxml, found: ${JSON.stringify(display)}`);
            }
        }
    }

    return displays;
}

function calculateDiskStats(info) {
    if (!('block.count' in info))
        return;
    const count = info['block.count']['v'];
    if (!count)
        return;

    // Libvirt reports disk capacity since version 1.2.18 (year 2015)
    // TODO: If disk stats is required for old systems, find a way how to get it when 'block.X.capacity' is not present, consider various options for 'sources'
    const disksStats = {};
    for (let i=0; i<count; i++) {
        const target = info[`block.${i}.name`]['v'];
        const physical = info[`block.${i}.physical`]['v'] || NaN;
        const capacity = info[`block.${i}.capacity`]['v'] || NaN;
        const allocation = info[`block.${i}.allocation`]['v'] || NaN;

        if (target) {
            disksStats[target] = {
                physical,
                capacity,
                allocation,
            };
        } else {
            console.error(`calculateDiskStats(): mandatory property is missing in info (block.${i}.name)`);
        }
    }
    return disksStats;
}

function buildConsoleVVFile(consoleDetail) {
    return '[virt-viewer]\n' +
        `type=${consoleDetail.type}\n` +
        `host=${consoleDetail.address}\n` +
        `port=${consoleDetail.port}\n` +
        'delete-this-file=1\n' +
        'fullscreen=0\n';
}

function doUsagePolling (name, connectionName, objPath) {
    return (dispatch, getState) => {
        if (!usagePollingEnabled(getState(), name, connectionName)) {
            logDebug(`doUsagePolling(${name}, ${connectionName}): usage polling disabled, stopping loop`);
            return;
        }

        logDebug(`doUsagePolling(${name}, ${connectionName}, ${objPath})`);

        // https://libvirt.org/html/libvirt-libvirt-domain.html#virDomainStatsTypes
        // VIR_DOMAIN_STATS_BALLOON | VIR_DOMAIN_STATS_VCPU | VIR_DOMAIN_STATS_BLOCK
        clientLibvirt.call(objPath, 'org.libvirt.Domain', 'GetStats', [4|8|32, 0], { timeout: 5000 })
            .done(info => {
                info = info[0];

                let props = { name, connectionName, id: objPath };
                if ('balloon.rss' in info)
                    props['rssMemory'] = info['balloon.rss']['v'];
                // FIXME: use average over all VCPUs
                if ('vcpu.0.time' in info)
                    Object.assign(props, { actualTimeInMs: Date.now(), cpuTime: info['vcpu.0.time']['v'] });
                Object.assign(props, { disksStats: calculateDiskStats(info) });

                logDebug(`doUsagePolling: ${JSON.stringify(props)}`);
                dispatch(updateVm(props));
            })
            .fail(ex => console.warn(`GetStats(${name}, ${connectionName}) failed: ${JSON.stringify(ex)}`))
            .always(() => dispatch(delayPolling(doUsagePolling(name, connectionName, objPath), null, name, connectionName)));
    };
}

function handleDomainUndefined(dispatch, connectionName, name, objpath) {
    logDebug(`handleDomainUndefined ${connectionName} ${name}`);
    dispatch(undefineVm(connectionName, name));
}

function handleDomainStopped(dispatch, connectionName, name, objpath) {
    logDebug(`handleDomainStopped ${connectionName} ${name}`);
    dispatch(updateVm({connectionName, name, state: 'shutoff'}));
    // transient VMs don't have a separate Undefined event, so remove them on stop
    dispatch(undefineVm(connectionName, name, true));
}

function startEventMonitor(dispatch, connectionName) {
    if (connectionName !== 'session') {
        console.warn("FIXME: this PoC only supports session libvirt");
        return;
    }
    pManager.addEventListener('DomainDefined', (event, name, objpath) => dispatch(getVm(connectionName, objpath)));
    pManager.addEventListener('DomainUndefined', (event, name, objpath) => handleDomainUndefined(dispatch, connectionName, name, objpath));
    pManager.addEventListener('DomainStarted', (event, name, objpath) => dispatch(getVm(connectionName, objpath)));
    pManager.addEventListener('DomainStopped', (event, name, objpath) => handleDomainStopped(dispatch, connectionName, name, objpath));

    // TODO: more fine-grained signal subscription once there are signals that don't change the device configuration
    clientLibvirt.subscribe({ interface: 'org.libvirt.Domain' }, (path, iface, signal, args) => {
        logDebug(`signal on ${path}: ${iface}.${signal}(${JSON.stringify(args)})`);
        dispatch(getVm(connectionName, path));
    });
}

export default LIBVIRT_PROVIDER;
