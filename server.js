#!/usr/bin/env node
import { serverDirectory } from './src/server-directory.js';

function wantsOriginalServer(argv) {
    return argv.includes('--original') || argv.includes('--mode=original') || argv.includes('--web');
}

function stripLauncherArgs(argv) {
    return argv.filter(arg => !['--original', '--mode=original', '--web'].includes(arg));
}

try {
    if (wantsOriginalServer(process.argv.slice(2))) {
        process.argv = stripLauncherArgs(process.argv);
        await import('./server-original.js');
    } else {
        console.log(`Node version: ${process.version}. Running in ${process.env.NODE_ENV} environment. Server directory: ${serverDirectory}`);
        process.chdir(serverDirectory);
        const { startCombinedRuntime } = await import('./src/combined-main.js');
        await startCombinedRuntime();
    }
} catch (error) {
    console.error('A critical error has occurred while starting the server:', error);
    process.exit(1);
}
