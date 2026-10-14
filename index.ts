import * as fs from "fs";
import * as path from "path";
import * as pulumi from "@pulumi/pulumi";
import * as aws from "@pulumi/aws";
import * as vsphere from "@pulumi/vsphere";

// All environment-specific values come from stack config. Provider settings
// (server, credentials) live under the `vsphere:` namespace and are picked up
// by the default provider.
const config = new pulumi.Config();
const datacenterName = config.require("datacenter");
const clusterName = config.require("cluster");
const resourcePoolName = config.get("resourcePool");
const folderName = config.get("folder");
const datastoreName = config.require("datastore");
const networkName = config.require("network");
const templateName = config.require("template");
const vmName = config.require("vmName");
const cpus = config.requireNumber("cpus");
const memoryMb = config.requireNumber("memoryMb");
const sshPublicKey = config.get("sshPublicKey");
// In simulate mode (vcsim) no guest ever boots, so don't wait for guest networking.
const simulate = config.getBoolean("simulate") ?? false;

// ---------------------------------------------------------------------------
// Inventory lookups
// ---------------------------------------------------------------------------
const datacenter = vsphere.getDatacenterOutput({ name: datacenterName });
const datacenterId = datacenter.id;

// A named resource pool overrides the cluster's root resource pool.
const resourcePoolId = resourcePoolName
    ? vsphere.getResourcePoolOutput({ name: resourcePoolName, datacenterId }).id
    : vsphere.getComputeClusterOutput({ name: clusterName, datacenterId }).resourcePoolId;

const datastore = vsphere.getDatastoreOutput({ name: datastoreName, datacenterId });
const network = vsphere.getNetworkOutput({ name: networkName, datacenterId });
// The template name may be a folder path, e.g. "templates/ubuntu-2404-cloud".
const template = vsphere.getVirtualMachineOutput({ name: templateName, datacenterId });

// ---------------------------------------------------------------------------
// VM folder: use the configured existing folder, otherwise create one.
// ---------------------------------------------------------------------------
let folder: pulumi.Input<string>;
if (folderName) {
    folder = folderName;
} else {
    folder = new vsphere.Folder("pulumi-demo", {
        type: "vm",
        path: "pulumi-demo",
        datacenterId,
    }).path;
}

// ---------------------------------------------------------------------------
// cloud-init payload, delivered via guestinfo
// ---------------------------------------------------------------------------
const sshBlock = sshPublicKey
    ? `ssh_authorized_keys:\n  - ${JSON.stringify(sshPublicKey.trim())}`
    : "";
const userdata = fs
    .readFileSync(path.join(__dirname, "cloud-init.yaml"), "utf8")
    .replace(/\$\{HOSTNAME\}/g, vmName)
    .replace(/\$\{SSH_AUTHORIZED_KEYS\}/g, sshBlock);
const metadata = `instance-id: ${vmName}\nlocal-hostname: ${vmName}\n`;
const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64");

// ---------------------------------------------------------------------------
// Virtual machine, cloned from the template
// ---------------------------------------------------------------------------
// Disk and NIC settings are copied from the template; guard against templates
// that report none.
const disk0 = template.disks.apply(disks => ({
    size: disks.length > 0 ? disks[0].size : 20,
    eagerlyScrub: disks.length > 0 ? disks[0].eagerlyScrub : false,
    thinProvisioned: disks.length > 0 ? disks[0].thinProvisioned : true,
}));
const adapterType = template.networkInterfaceTypes.apply(types =>
    types.length > 0 ? types[0] : "vmxnet3",
);

const vm = new vsphere.VirtualMachine(vmName, {
    name: vmName,
    folder,
    resourcePoolId,
    datastoreId: datastore.id,
    numCpus: cpus,
    memory: memoryMb,
    guestId: template.guestId,
    scsiType: template.scsiType,
    firmware: template.firmware,
    networkInterfaces: [{ networkId: network.id, adapterType }],
    disks: [
        {
            label: "disk0",
            size: disk0.size,
            eagerlyScrub: disk0.eagerlyScrub,
            thinProvisioned: disk0.thinProvisioned,
        },
    ],
    // No `customize` block: cloud-init handles guest configuration (DHCP).
    clone: { templateUuid: template.id },
    extraConfig: {
        "guestinfo.metadata": b64(metadata),
        "guestinfo.metadata.encoding": "base64",
        "guestinfo.userdata": b64(userdata),
        "guestinfo.userdata.encoding": "base64",
    },
    waitForGuestNetTimeout: simulate ? 0 : 10,
    waitForGuestIpTimeout: simulate ? 0 : 10,
});

// ---------------------------------------------------------------------------
// AWS Secrets Manager: on-prem VM inventory record, built from the VM's outputs.
// AWS credentials and region come from the linked ESC environment.
// ---------------------------------------------------------------------------
const tags = { project: pulumi.getProject(), stack: pulumi.getStack(), source: "vsphere" };

const inventorySecret = new aws.secretsmanager.Secret("vm-inventory", {
    name: `onprem/vms/${vmName}`,
    description: `vSphere VM ${vmName} registered by Pulumi`,
    // Delete immediately on destroy so the demo can be re-run with the same name.
    recoveryWindowInDays: 0,
    tags,
});

new aws.secretsmanager.SecretVersion("vm-inventory", {
    secretId: inventorySecret.id,
    secretString: pulumi.jsonStringify({
        name: vm.name,
        moid: vm.moid,
        uuid: vm.uuid,
        datacenter: datacenterName,
        cluster: clusterName,
        datastore: datastoreName,
        network: networkName,
        cpus: vm.numCpus,
        memoryMb: vm.memory,
        ipAddress: vm.defaultIpAddress,
        vcenter: new pulumi.Config("vsphere").get("vsphereServer") ?? "",
    }),
});

// ---------------------------------------------------------------------------
// Outputs
// ---------------------------------------------------------------------------
export { vmName };
export const inventorySecretName = inventorySecret.name;
export const inventorySecretArn = inventorySecret.arn;
export const vmMoid = vm.moid;
export const ipAddress = vm.defaultIpAddress;
export const url = vm.defaultIpAddress.apply(ip => (ip ? `http://${ip}` : "n/a (simulated)"));
