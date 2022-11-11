import _ from 'lodash';

import { ConfigOptions } from './backend';
import {
	ExtLinuxParseError,
	AppendDirectiveError,
	FDTDirectiveError,
} from '../../lib/errors';

export interface ExtlinuxFile {
	globals: Directive;
	labels: Label;
}

export interface Label {
	[labelName: string]: Directive;
}

export interface Directive {
	[directive: string]: string;
}

/**
 * ConfigurableDirective
 *
 * This class abstraction is the blueprint used to create new directives in extlinux
 * that we would want to be able to parse (get the value) and generate (create a value).
 *
 */
export abstract class ConfigurableDirective {
	// Parses the values for this directive
	public abstract parse(directives: Directive): ConfigOptions;
	// Return the value to be set for this directive using the provided ConfigOptions
	public abstract generate(opts: ConfigOptions, existingValue?: string): string;
}

/**
 * AppendDirective
 *
 * Add one or more options to the kernel command line.
 *
 */
export class AppendDirective extends ConfigurableDirective {
	private supportedConfigValues: string[];

	public constructor(supportedConfigValues: string[]) {
		super();
		this.supportedConfigValues = supportedConfigValues;
	}

	/**
	 * Parses a APPEND directive string into a ConfigOptions
	 *
	 * Example:
	 * 	parse({ APPEND: "ro rootwait isolcpus=0,4" })
	 * 	-> { 'ro': '', 'rootwait': '', 'isolcpus': '0,4' }
	 *
	 */
	public parse(directives: Directive): ConfigOptions {
		// Check that there is an APPEND directive to parse
		if (directives.APPEND == null) {
			throw new ExtLinuxParseError(
				'Could not find APPEND directive in default extlinux.conf boot entry',
			);
		}
		// Parse all the key and values into ConfigOptions
		return directives.APPEND.split(' ').reduce(
			(configOpts: ConfigOptions, appendValue: string) => {
				// Break this append config into key and value
				const [KEY, VALUE = '', more] = appendValue.split('=', 3);
				if (!KEY) {
					return configOpts; // No value to set so return
				} else if (more != null) {
					// APPEND value is not formatted correctly
					// Example: isolcpus=3=2 (more then 1 value being set)
					throw new AppendDirectiveError(
						`Unable to parse invalid value: ${appendValue}`,
					);
				}
				// Return key value pair with existing configs
				return { [KEY]: VALUE, ...configOpts };
			},
			{},
		);
	}

	/**
	 * Generates a string value for APPEND directive given a ConfigOptions
	 *
	 * Keys in existingValue that are also in the provided ConfigOptions
	 *  will be replaced with those from opts.
	 *
	 * Example:
	 * 	generate({ isolcpus: '0,4' })
	 * 	-> 'isolcpus=0,4'
	 *
	 */
	public generate(opts: ConfigOptions, existingValue: string = ''): string {
		// Parse current append line and remove whitelisted values
		// We remove whitelisted values to avoid duplicates
		const appendLine = existingValue.split(' ').filter((entry) => {
			const lhs = entry.split('=', 1);
			return !this.supportedConfigValues.includes(lhs[0]);
		});
		// Add new configurations values to the provided append line
		return appendLine
			.concat(
				_.map(opts, (value, key) => {
					if (key.includes('=') || value.includes('=')) {
						throw new AppendDirectiveError(
							`One of the values being set contains an invalid character: [ value: ${value}, key: ${key} ]`,
						);
					} else if (!value) {
						// Example: rootwait (config without a value)
						return `${key}`;
					} else {
						// Example: isolcpus=2,3 (config with a value)
						return `${key}=${value}`;
					}
				}),
			)
			.join(' ')
			.trim();
	}
}

/**
 * FDTDirective
 *
 * Configure the location of Device Tree Binary
 *
 */
export class FDTDirective extends ConfigurableDirective {
	/**
	 * Parses a FDT directive string into a ConfigOptions
	 *
	 * Example:
	 * 	parse({ FDT: '/boot/mycustomdtb.dtb' })
	 * 	-> { 'fdt': '/boot/mycustomdtb.dtb' }
	 *
	 */
	public parse(directives: Directive): ConfigOptions {
		// NOTE: We normalize FDT to lowercase fdt
		return directives.FDT ? { fdt: directives.FDT } : {};
	}

	/**
	 * Generates a string value for FDT directive given a ConfigOptions
	 *
	 * Example:
	 * 	generate({ fdt: '/boot/mycustomdtb.dtb' })
	 * 	-> '/boot/mycustomdtb.dtb'
	 *
	 */
	public generate(opts: ConfigOptions): string {
		if (typeof opts.fdt !== 'string') {
			throw new FDTDirectiveError(
				`Cannot set FDT of non-string value: ${opts.fdt}`,
			);
		}
		if (opts.fdt.length === 0) {
			throw new FDTDirectiveError('Cannot set FDT of an empty value.');
		}
		return opts.fdt;
	}
}
