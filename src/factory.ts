import { Pass } from "./pass";
import { Certificates, isValid, FactoryOptions, PartitionedBundle, BundleUnit, FinalCertificates } from "./schema";

import { promisify } from "util";
import { readFile as _readFile, readdir as _readdir } from "fs";
import * as path from "path";
import forge from "node-forge";
import formatMessage from "./messages";
import { removeHidden } from "./utils";

const readDir = promisify(_readdir);
const readFile = promisify(_readFile);

export type Pass = InstanceType<typeof Pass>

export async function createPass(options: FactoryOptions): Promise<Pass> {
	if (!(options && Object.keys(options).length)) {
		throw new Error(formatMessage("CP_NO_OPTS"));
	}

	try {
		const [bundle, certificates] = await Promise.all([
			getModelContents(options.model),
			readCertificatesFromOptions(options.certificates)
		]);

		return new Pass({
			model: bundle,
			certificates,
			overrides: options.overrides
		});
	} catch (err) {
		console.log(err);
		throw new Error(formatMessage("CP_INIT_ERROR"));
	}
}

async function getModelContents(model: FactoryOptions["model"]) {
	const isModelValid = (
		model && (
			typeof model === "string" || (
				typeof model === "object" &&
				Object.keys(model).length
			)
		)
	);

	if (!isModelValid) {
		throw new Error(formatMessage("MODEL_NOT_VALID"));
	}

	let modelContents: PartitionedBundle;

	if (typeof model === "string") {
		modelContents = await getModelFolderContents(model);
	} else {
		modelContents = getModelBufferContents(model);
	}

	const modelFiles = Object.keys(modelContents.bundle);

	if (!(modelFiles.includes("pass.json") && modelContents.bundle["pass.json"].length && modelFiles.some(file => Boolean(file.includes("icon") && modelContents.bundle[file].length)))) {
		throw new Error("missing icon or pass.json");
	}

	return modelContents;
}

/**
 * Reads and model contents and creates a splitted
 * bundles-object.
 * @param model
 */

async function getModelFolderContents(model: string): Promise<PartitionedBundle> {
	try {
		const modelPath = path.resolve(model) + (!!model && !path.extname(model) ? ".pass" : "");
		const modelFilesList = await readDir(modelPath);

		// No dot-starting files, manifest and signature
		const filteredFiles = removeHidden(modelFilesList).filter(f => !/(manifest|signature)/i.test(f));

		const isModelInitialized = (
			filteredFiles.length &&
			filteredFiles.some(file => file.toLowerCase().includes("icon"))
		);

		// Icon is required to proceed
		if (!isModelInitialized) {
			throw new Error(formatMessage(
				"MODEL_UNINITIALIZED",
				path.parse(this.model).name
			));
		}

		// Splitting files from localization folders
		const rawBundle = filteredFiles.filter(entry => !entry.includes(".lproj"));
		const l10nFolders = filteredFiles.filter(entry => entry.includes(".lproj"));

		const bundleBuffers = rawBundle.map(file => readFile(path.resolve(modelPath, file)));
		const buffers = await Promise.all(bundleBuffers);

		const bundle: BundleUnit = Object.assign({},
			...rawBundle.map((fileName, index) => ({ [fileName]: buffers[index] }))
		);

		// Reading concurrently localizations folder
		// and their files and their buffers
		const L10N_FilesListByFolder: Array<BundleUnit> = await Promise.all(
			l10nFolders.map(folderPath => {
				// Reading current folder
				const currentLangPath = path.join(modelPath, folderPath);
				return readDir(currentLangPath)
					.then(files => {
						// Transforming files path to a model-relative path
						const validFiles = removeHidden(files)
							.map(file => path.join(currentLangPath, file));

						// Getting all the buffers from file paths
						return Promise.all([
							...validFiles.map(file =>
								readFile(file).catch(() => Buffer.alloc(0))
							)
						]).then(buffers =>
							// Assigning each file path to its buffer
							// and discarding the empty ones
							validFiles.reduce<BundleUnit>((acc, file, index) => {
								if (!buffers[index].length) {
									return acc;
								}

								return { ...acc, [file]: buffers[index] };
							}, {})
						);
					});
			})
		);

		const l10nBundle: PartitionedBundle["l10nBundle"] = Object.assign(
			{},
			...L10N_FilesListByFolder
				.map((folder, index) => ({ [l10nFolders[index]]: folder }))
		);

		return {
			bundle,
			l10nBundle
		};
	} catch (err) {
		if (err.code && err.code === "ENOENT") {
			if (err.syscall === "open") {
				// file opening failed
				throw new Error(formatMessage("MODELF_NOT_FOUND", err.path))
			} else if (err.syscall === "scandir") {
				// directory reading failed
				const pathContents = (err.path as string).split(/(\/|\\\?)/);
				throw new Error(formatMessage(
					"MODELF_FILE_NOT_FOUND",
					pathContents[pathContents.length-1]
				))
			}
		}

		throw err;
	}
}

/**
 * Analyzes the passed buffer model and splits it to
 * return buffers and localization files buffers.
 * @param model
 */

function getModelBufferContents(model: BundleUnit): PartitionedBundle {
	const rawBundle = removeHidden(Object.keys(model)).reduce<BundleUnit>((acc, current) => {
		// Checking if current file is one of the autogenerated ones or if its
		// content is not available
		if (/(manifest|signature)/.test(current) || !rawBundle[current]) {
			return acc;
		}

		return { ...acc, [current]: model[current] };
	}, {});

	const bundleKeys = Object.keys(rawBundle);

	const isModelInitialized = (
		bundleKeys.length &&
		bundleKeys.some(file => file.toLowerCase().includes("icon"))
	);

	// Icon is required to proceed
	if (!isModelInitialized) {
		throw new Error(formatMessage("MODEL_UNINITIALIZED", "Buffers"))
	}

	// separing localization folders
	const l10nFolders = bundleKeys.filter(file => file.includes(".lproj"));
	const l10nBundle: PartitionedBundle["l10nBundle"] = Object.assign({},
		...l10nFolders.map<BundleUnit>(folder =>
			({ [folder]: rawBundle[folder] })
		)
	);

	const bundle: BundleUnit = Object.assign({},
		...bundleKeys
			.filter(file => !file.includes(".lproj"))
			.map(file => ({ [file]: rawBundle[file] }))
	);

	return {
		bundle,
		l10nBundle
	};
}

/**
 * Reads certificate contents, if the passed content is a path,
 * and parses them as a PEM.
 * @param options
 */

async function readCertificatesFromOptions(options: Certificates): Promise<FinalCertificates> {
	if (!(options && Object.keys(options).length && isValid(options, "certificatesSchema"))) {
		throw new Error(formatMessage("CP_NO_CERTS"));
	}

	// if the signerKey is an object, we want to get
	// all the real contents and don't care of passphrase
	const flattenedDocs = Object.assign({}, options, {
		signerKey: (
			typeof options.signerKey === "string"
			? options.signerKey
			: options.signerKey.keyFile
		)
	});

	// We read the contents
	const rawContentsPromises = Object.keys(flattenedDocs)
		.map(key => {
			const content = flattenedDocs[key];

			if (!!path.parse(content).ext) {
				// The content is a path to the document
				return readFile(path.resolve(content), { encoding: "utf8"});
			} else {
				// Content is the real document content
				return Promise.resolve(content);
			}
		});

	try {
		const parsedContents = await Promise.all(rawContentsPromises);
		const pemParsedContents = parsedContents.map((file, index) => {
			const certName = Object.keys(options)[index];
			const pem = parsePEM(
				certName,
				file,
				typeof options.signerKey === "object"
					? options.signerKey.passphrase
					: undefined
			);

			if (!pem) {
				throw new Error(formatMessage("INVALID_CERTS", certName));
			}

			return { [certName]: pem };
		});

		return Object.assign({}, ...pemParsedContents);
	} catch (err) {
		if (!err.path) {
			throw err;
		}

		throw new Error(formatMessage("INVALID_CERT_PATH", path.parse(err.path).base));
	}
}

/**
 * Parses the PEM-formatted passed text (certificates)
 *
 * @param element - Text content of .pem files
 * @param passphrase - passphrase for the key
 * @returns The parsed certificate or key in node forge format
 */

function parsePEM(pemName: string, element: string, passphrase?: string) {
	if (pemName === "signerKey" && passphrase) {
		return forge.pki.decryptRsaPrivateKey(element, String(passphrase));
	} else {
		return forge.pki.certificateFromPem(element);
	}
}

module.exports = { createPass };
