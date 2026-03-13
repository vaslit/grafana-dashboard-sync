"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.InstanceSecretStorage = void 0;
class InstanceSecretStorage {
    secrets;
    constructor(secrets) {
        this.secrets = secrets;
    }
    async getInstanceToken(projectRootPath, instanceName) {
        return this.secrets.get(this.instanceTokenKey(projectRootPath, instanceName));
    }
    async setInstanceToken(projectRootPath, instanceName, token) {
        await this.secrets.store(this.instanceTokenKey(projectRootPath, instanceName), token);
    }
    async deleteInstanceToken(projectRootPath, instanceName) {
        await this.secrets.delete(this.instanceTokenKey(projectRootPath, instanceName));
    }
    instanceTokenKey(projectRootPath, instanceName) {
        return `grafanaDashboards.instanceToken:${projectRootPath}:${instanceName}`;
    }
}
exports.InstanceSecretStorage = InstanceSecretStorage;
//# sourceMappingURL=instanceSecretStorage.js.map