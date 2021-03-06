import { Component } from '@angular/core';

import { ApiService } from 'jslib/abstractions/api.service';
import { CipherService } from 'jslib/abstractions/cipher.service';
import { CryptoService } from 'jslib/abstractions/crypto.service';
import { FolderService } from 'jslib/abstractions/folder.service';
import { I18nService } from 'jslib/abstractions/i18n.service';
import { MessagingService } from 'jslib/abstractions/messaging.service';
import { PasswordGenerationService } from 'jslib/abstractions/passwordGeneration.service';
import { PlatformUtilsService } from 'jslib/abstractions/platformUtils.service';
import { PolicyService } from 'jslib/abstractions/policy.service';
import { SyncService } from 'jslib/abstractions/sync.service';
import { UserService } from 'jslib/abstractions/user.service';

import {
    ChangePasswordComponent as BaseChangePasswordComponent,
} from 'jslib/angular/components/change-password.component';

import { EmergencyAccessStatusType } from 'jslib/enums/emergencyAccessStatusType';
import { Utils } from 'jslib/misc/utils';

import { EncString } from 'jslib/models/domain/encString';
import { SymmetricCryptoKey } from 'jslib/models/domain/symmetricCryptoKey';

import { CipherWithIdRequest } from 'jslib/models/request/cipherWithIdRequest';
import { EmergencyAccessUpdateRequest } from 'jslib/models/request/emergencyAccessUpdateRequest';
import { FolderWithIdRequest } from 'jslib/models/request/folderWithIdRequest';
import { OrganizationUserResetPasswordEnrollmentRequest } from 'jslib/models/request/organizationUserResetPasswordEnrollmentRequest';
import { PasswordRequest } from 'jslib/models/request/passwordRequest';
import { UpdateKeyRequest } from 'jslib/models/request/updateKeyRequest';

@Component({
    selector: 'app-change-password',
    templateUrl: 'change-password.component.html',
})
export class ChangePasswordComponent extends BaseChangePasswordComponent {
    rotateEncKey = false;
    currentMasterPassword: string;

    constructor(i18nService: I18nService,
        cryptoService: CryptoService, messagingService: MessagingService,
        userService: UserService, passwordGenerationService: PasswordGenerationService,
        platformUtilsService: PlatformUtilsService, policyService: PolicyService,
        private folderService: FolderService, private cipherService: CipherService,
        private syncService: SyncService, private apiService: ApiService) {
        super(i18nService, cryptoService, messagingService, userService, passwordGenerationService,
            platformUtilsService, policyService);
    }

    async rotateEncKeyClicked() {
        if (this.rotateEncKey) {
            const ciphers = await this.cipherService.getAllDecrypted();
            let hasOldAttachments = false;
            if (ciphers != null) {
                for (let i = 0; i < ciphers.length; i++) {
                    if (ciphers[i].organizationId == null && ciphers[i].hasOldAttachments) {
                        hasOldAttachments = true;
                        break;
                    }
                }
            }

            if (hasOldAttachments) {
                const learnMore = await this.platformUtilsService.showDialog(
                    this.i18nService.t('oldAttachmentsNeedFixDesc'), null,
                    this.i18nService.t('learnMore'), this.i18nService.t('close'), 'warning');
                if (learnMore) {
                    this.platformUtilsService.launchUri(
                        'https://help.bitwarden.com/article/attachments/#fixing-old-attachments');
                }
                this.rotateEncKey = false;
                return;
            }

            const result = await this.platformUtilsService.showDialog(
                this.i18nService.t('updateEncryptionKeyWarning') + ' ' +
                this.i18nService.t('updateEncryptionKeyExportWarning') + ' ' +
                this.i18nService.t('rotateEncKeyConfirmation'), this.i18nService.t('rotateEncKeyTitle'),
                this.i18nService.t('yes'), this.i18nService.t('no'), 'warning');
            if (!result) {
                this.rotateEncKey = false;
            }
        }
    }

    async submit() {
        const hasEncKey = await this.cryptoService.hasEncKey();
        if (!hasEncKey) {
            this.platformUtilsService.showToast('error', null, this.i18nService.t('updateKey'));
            return;
        }

        await super.submit();
    }

    async setupSubmitActions() {
        if (this.currentMasterPassword == null || this.currentMasterPassword === '') {
            this.platformUtilsService.showToast('error', this.i18nService.t('errorOccurred'),
                this.i18nService.t('masterPassRequired'));
            return false;
        }

        if (this.rotateEncKey) {
            await this.syncService.fullSync(true);
        }

        return super.setupSubmitActions();
    }

    async performSubmitActions(newMasterPasswordHash: string, newKey: SymmetricCryptoKey,
        newEncKey: [SymmetricCryptoKey, EncString]) {
        const request = new PasswordRequest();
        request.masterPasswordHash = await this.cryptoService.hashPassword(this.currentMasterPassword, null);
        request.newMasterPasswordHash = newMasterPasswordHash;
        request.key = newEncKey[1].encryptedString;

        try {
            if (this.rotateEncKey) {
                this.formPromise = this.apiService.postPassword(request).then(() => {
                    return this.updateKey(newKey, request.newMasterPasswordHash);
                });
            } else {
                this.formPromise = this.apiService.postPassword(request);
            }

            await this.formPromise;

            this.platformUtilsService.showToast('success', this.i18nService.t('masterPasswordChanged'),
                this.i18nService.t('logBackIn'));
            this.messagingService.send('logout');
        } catch {
            this.platformUtilsService.showToast('error', null, this.i18nService.t('errorOccurred'));
        }
    }

    private async updateKey(key: SymmetricCryptoKey, masterPasswordHash: string) {
        const encKey = await this.cryptoService.makeEncKey(key);
        const privateKey = await this.cryptoService.getPrivateKey();
        let encPrivateKey: EncString = null;
        if (privateKey != null) {
            encPrivateKey = await this.cryptoService.encrypt(privateKey, encKey[0]);
        }
        const request = new UpdateKeyRequest();
        request.privateKey = encPrivateKey != null ? encPrivateKey.encryptedString : null;
        request.key = encKey[1].encryptedString;
        request.masterPasswordHash = masterPasswordHash;

        const folders = await this.folderService.getAllDecrypted();
        for (let i = 0; i < folders.length; i++) {
            if (folders[i].id == null) {
                continue;
            }
            const folder = await this.folderService.encrypt(folders[i], encKey[0]);
            request.folders.push(new FolderWithIdRequest(folder));
        }

        const ciphers = await this.cipherService.getAllDecrypted();
        for (let i = 0; i < ciphers.length; i++) {
            if (ciphers[i].organizationId != null) {
                continue;
            }

            const cipher = await this.cipherService.encrypt(ciphers[i], encKey[0]);
            request.ciphers.push(new CipherWithIdRequest(cipher));
        }

        await this.apiService.postAccountKey(request);

        await this.updateEmergencyAccesses(encKey[0]);

        await this.updateAllResetPasswordKeys(encKey[0]);
    }

    private async updateEmergencyAccesses(encKey: SymmetricCryptoKey) {
        const emergencyAccess = await this.apiService.getEmergencyAccessTrusted();
        const allowedStatuses = [
            EmergencyAccessStatusType.Confirmed,
            EmergencyAccessStatusType.RecoveryInitiated,
            EmergencyAccessStatusType.RecoveryApproved,
        ];

        const filteredAccesses = emergencyAccess.data.filter(d => allowedStatuses.includes(d.status));

        for (const details of filteredAccesses) {
            const publicKeyResponse = await this.apiService.getUserPublicKey(details.granteeId);
            const publicKey = Utils.fromB64ToArray(publicKeyResponse.publicKey);

            const encryptedKey = await this.cryptoService.rsaEncrypt(encKey.key, publicKey.buffer);

            const updateRequest = new EmergencyAccessUpdateRequest();
            updateRequest.type = details.type;
            updateRequest.waitTimeDays = details.waitTimeDays;
            updateRequest.keyEncrypted = encryptedKey.encryptedString;

            await this.apiService.putEmergencyAccess(details.id, updateRequest);
        }
    }

    private async updateAllResetPasswordKeys(encKey: SymmetricCryptoKey) {
        const orgs = await this.userService.getAllOrganizations();

        for (const org of orgs) {
            // If not already enrolled, skip
            if (!org.resetPasswordEnrolled) {
                continue;
            }

            // Retrieve public key
            const response = await this.apiService.getOrganizationKeys(org.id);
            const publicKey = Utils.fromB64ToArray(response?.publicKey);

            // Re-enroll - encrpyt user's encKey.key with organization public key
            const encryptedKey = await this.cryptoService.rsaEncrypt(encKey.key, publicKey.buffer);

            // Create/Execute request
            const request = new OrganizationUserResetPasswordEnrollmentRequest();
            request.resetPasswordKey = encryptedKey.encryptedString;

            await this.apiService.putOrganizationUserResetPasswordEnrollment(org.id, org.userId, request);
        }
    }
}
