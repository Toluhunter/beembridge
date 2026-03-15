export namespace main {

	export class SelectedItem {
	    path: string;
	    name: string;
	    size: number;
	    isDirectory: boolean;

	    static createFrom(source: any = {}) {
	        return new SelectedItem(source);
	    }

	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.path = source["path"];
	        this.name = source["name"];
	        this.size = source["size"];
	        this.isDirectory = source["isDirectory"];
	    }
	}

}

export namespace peerdiscovery {

	export class DiscoveredPeer {
	    appId: string;
	    instanceId: string;
	    peerName: string;
	    tcpPort: number;
	    timestamp: number;
	    // Go type: time
	    lastSeen: any;
	    ipAddress: string;

	    static createFrom(source: any = {}) {
	        return new DiscoveredPeer(source);
	    }

	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.appId = source["appId"];
	        this.instanceId = source["instanceId"];
	        this.peerName = source["peerName"];
	        this.tcpPort = source["tcpPort"];
	        this.timestamp = source["timestamp"];
	        this.lastSeen = this.convertValues(source["lastSeen"], null);
	        this.ipAddress = source["ipAddress"];
	    }

		convertValues(a: any, classs: any, asMap: boolean = false): any {
		    if (!a) {
		        return a;
		    }
		    if (a.slice && a.map) {
		        return (a as any[]).map(elem => this.convertValues(elem, classs));
		    } else if ("object" === typeof a) {
		        if (asMap) {
		            for (const key of Object.keys(a)) {
		                a[key] = new classs(a[key]);
		            }
		            return a;
		        }
		        return new classs(a);
		    }
		    return a;
		}
	}

}
