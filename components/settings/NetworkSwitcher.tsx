'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useSoroban } from '@/lib/soroban/SorobanProvider';

/**
 * Typed registry of predefined Soroban RPC environments.
 * A custom endpoint can be supplied at runtime in addition to these.
 */
export interface SorobanEnvironment {
  name: string;
  rpcUrl: string;
  networkPassphrase: string;
}

type NetworkKey = 'testnet' | 'futurenet' | 'custom';

interface NetworkOption {
  key: NetworkKey;
  label: string;
}

export const PREDEFINED_ENVIRONMENTS: SorobanEnvironment[] = [
  {
    name: 'Testnet',
    rpcUrl: 'https://soroban-testnet.stellar.org',
    networkPassphrase: 'Test SDF Network ; September 2015',
  },
  {
    name: 'Futurenet',
    rpcUrl: 'https://rpc-futurenet.stellar.org',
    networkPassphrase: 'Test SDF Future Network ; October 2022',
  },
];

const PREDEFINED_NETWORKS: NetworkOption[] = [
  {
    key: 'testnet',
    label: 'Testnet',
  },
  {
    key: 'futurenet',
    label: 'Futurenet',
  },
];
  rpcUrl: string;
  networkPassphrase: string;
}

import { useSoroban } from '@/lib/soroban/SorobanProvider';

type NetworkKey = 'testnet' | 'futurenet' | 'custom';

interface NetworkOption {
  key: NetworkKey;
  label: string;
  rpcUrl: string;
  networkPassphrase: string;
}

const PREDEFINED_NETWORKS: NetworkOption[] = [
  {
    key: 'testnet',
    label: 'Testnet',
    rpcUrl: 'https://soroban-testnet.stellar.org',
    networkPassphrase: 'Test SDF Network ; September 2015',
  },
  {
    key: 'futurenet',
    label: 'Futurenet',
    rpcUrl: 'https://rpc-futurenet.stellar.org',
    networkPassphrase: 'Test SDF Future Network ; October 2022',
  },
];

const PREDEFINED_NETWORKS: NetworkOption[] = [
  {
    key: 'testnet',
    label: 'Testnet',
    rpcUrl: 'https://soroban-testnet.stellar.org',
    networkPassphrase: 'Test SDF Network ; September 2015',
  },
  {
    key: 'futurenet',
    label: 'Futurenet',
    rpcUrl: 'https://rpc-futurenet.stellar.org',
    networkPassphrase: 'Test SDF Future Network ; October 2022',
  },
];

      )}
    </div>
  );
}
