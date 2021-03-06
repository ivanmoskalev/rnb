import * as Config from '../config';
import execa from 'execa';
import { FsUtil, TimeUtil } from '../util';
import path from 'path';
import fse from 'fs-extra';
import plist from 'plist';
import bplist from 'bplist-parser';
import { Task } from './common';

interface BuildIosParams extends Task {
    config: Config.IosTarget;
}

export default async function build(params: BuildIosParams): Promise<boolean> {
    const { projectDirectory, outputDirectory, cacheDirectory, config, tempDirectory } = params;

    const stopwatch = new TimeUtil.Stopwatch();
    console.log('[rnb] [ios] Starting build...');

    const xcarchivePath = path.join(tempDirectory, `${config.xcodeSchemeName}-${config.xcodeConfigName}.xcarchive`);
    const artifactSpec = config.artifacts || ['ipa'];

    {
        console.log('[rnb] [ios] Running xcodebuild...');

        const codesigningParams =
            (config.codesigning && [
                'CODE_SIGN_STYLE=Manual',
                `CODE_SIGN_IDENTITY=${config.codesigning.signingIdentity}`,
                `PROVISIONING_PROFILE=`,
                `PROVISIONING_PROFILE_SPECIFIER=${config.codesigning.provisioningProfileName}`,
            ]) ||
            [];

        const extraCliArgs = config.xcodebuildExtraCommandLineArgs || [];

        await execa(
            'xcodebuild',
            [
                'archive',
                '-workspace',
                config.xcodeWorkspaceName,
                '-scheme',
                config.xcodeSchemeName,
                '-configuration',
                config.xcodeConfigName,
                '-archivePath',
                xcarchivePath,
                ...codesigningParams,
                ...extraCliArgs,
            ],
            { cwd: `${projectDirectory}/ios` }
        );

        console.log(`[rnb] [ios] Running xcodebuild... Done in ${TimeUtil.humanReadableDuration(stopwatch.splitTime())}!`);
    }

    if (artifactSpec.includes('ipa')) {
        console.log('[rnb] [ios] Exporting IPA from .xcarchive...');

        // TODO: this should be done in a temp dir

        const allProvisioningProfileFiles = await findAllProvisioningProfilesInXcarchive(xcarchivePath);
        const bundleIdToProvProfileMapping = await Promise.all(
            allProvisioningProfileFiles.map(async (mobileprovisionPath) => {
                const directory = path.dirname(mobileprovisionPath);
                const infoPlistPath = path.join(directory, 'Info.plist');
                const infoPlist = await bplist.parseFile(infoPlistPath);
                const bundleId = infoPlist[0]['CFBundleIdentifier'];
                const command = execa.commandSync(`security cms -D -i ${mobileprovisionPath}`);
                const provProfPlist = plist.parse(command.stdout);
                const provProfileUuid = provProfPlist['UUID'];
                return `<key>${bundleId}</key><string>${provProfileUuid}</string>`;
            })
        );

        const exportPlistPath = `${xcarchivePath}.export.plist`;
        const exportPlist = `
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>method</key>
  <string>${config.codesigning?.ipaExportMethod || 'app-store'}</string>
  <key>signingStyle</key>
  <string>manual</string>
  <key>provisioningProfiles</key>
  <dict>
    ${bundleIdToProvProfileMapping.join('\n    ')}
  </dict>
  ${config.ipaExportConfig?.compileBitcode ? '<key>compileBitcode</key><true/>' : '<key>compileBitcode</key><false/>'}
</dict>
</plist>`;
        await fse.writeFile(exportPlistPath, exportPlist);

        await execa('xcodebuild', [
            '-exportArchive',
            '-archivePath',
            xcarchivePath,
            '-exportPath',
            `${tempDirectory}`,
            '-exportOptionsPlist',
            exportPlistPath,
        ]);

        console.log(`[rnb] [ios] Exporting IPA from .xcarchive... Done in ${TimeUtil.humanReadableDuration(stopwatch.splitTime())}!`);
    }

    {
        console.log(`[rnb] [ios] Copying artifact files: ${artifactSpec}...`);

        await Promise.all(
            artifactSpec.map(async (a) => {
                const files = await FsUtil.findFilesRecursively({
                    dir: tempDirectory,
                    matching: artifactPatternFor(a),
                });
                files.forEach((srcPath) => {
                    const dstPath = path.join(outputDirectory, a, path.basename(srcPath));
                    fse.mkdirpSync(path.join(outputDirectory, a));
                    console.log(`[rnb] [ios] Copying '${srcPath}' to '${dstPath}'`);
                    fse.copyFileSync(srcPath, dstPath);
                });
                return Promise.resolve();
            })
        );

        console.log(`[rnb] [ios] Copying artifact files... Done in ${TimeUtil.humanReadableDuration(stopwatch.splitTime())}!`);
    }

    console.log(`[rnb] [ios] Build finished in ${TimeUtil.humanReadableDuration(stopwatch.totalDuration())}!`);

    return true;
}

async function findAllProvisioningProfilesInXcarchive(xсarchivePath: string): Promise<string[]> {
    return FsUtil.findFilesRecursively({
        dir: path.join(xсarchivePath, '/Products/'),
        matching: /\.mobileprovision$/,
    });
}

function artifactPatternFor(artifactSpec: Config.IosArtifact): RegExp {
    switch (artifactSpec) {
        case 'ipa':
            return /\.ipa$/;
        case 'xcarchive':
            return /\.xcarchive/;
        case 'dSYM':
            return /\.dSYM/;
    }
}
