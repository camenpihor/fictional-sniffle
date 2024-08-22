import React, { useEffect, useRef, useState } from "react";
import mapboxgl from "mapbox-gl";
import { debounce } from "lodash";
import "./App.css";
import NewTreeForm from "./components/NewTreeForm";
import { fetchTreeInfo, fetchTreeLocations, sendAddLocation, sendRemoveLocation, treeToFeature } from "./api";

mapboxgl.accessToken = process.env.REACT_APP_MAPBOX_TOKEN;



const addTreeLayers = (map, geojsonData) => {
  map.addSource("trees", {
    type: "geojson",
    data: geojsonData,
    cluster: true,
    clusterMaxZoom: 16,
    clusterRadius: 50,
  });

  const layers = [
    {
      id: "clusters",
      type: "circle",
      source: "trees",
      filter: ["has", "point_count"],
      paint: { "circle-color": "#51bbd6", "circle-radius": 20 },
    },
    {
      id: "highlighted-cluster",
      type: "circle",
      source: "trees",
      filter: ["in", "cluster_id", ""],
      paint: { "circle-color": "#FFD580", "circle-radius": 20 },
    },
    {
      id: "cluster-count",
      type: "symbol",
      source: "trees",
      filter: ["has", "point_count"],
      layout: {
        "text-field": "{point_count_abbreviated}",
        "text-font": ["DIN Offc Pro Medium", "Arial Unicode MS Bold"],
        "text-size": 12,
      },
    },
    {
      id: "unclustered-point",
      type: "circle",
      source: "trees",
      filter: ["!", ["has", "point_count"]],
      paint: { "circle-color": "#11b4da", "circle-radius": 15 },
    },
    {
      id: "highlighted-point",
      type: "circle",
      source: "trees",
      filter: ["in", "common_name", ""],
      paint: { "circle-color": "#FFD580", "circle-radius": 15 },
    },
  ];
  layers.forEach((layer) => map.addLayer(layer));
};

const getClusterFeatures = (map, clusterId) => {
  const source = map.getSource("trees");
  return new Promise((resolve, reject) => {
    source.getClusterLeaves(clusterId, Infinity, 0, (error, leaves) => {
      if (error) {
        reject(error);
      } else {
        resolve(leaves || []);
      }
    });
  });
};

const updateVisibleTrees = async (map, setVisibleTrees) => {
  let trees = map.queryRenderedFeatures({layers: ["unclustered-point"]});
  trees = Array
    .from(new Set(trees.map(feature => feature.properties.location_id)))
    .map(location_id => trees.find(feature => feature.properties.location_id === location_id));
  const clusters = map.queryRenderedFeatures({layers: ["clusters"]});
  const groupedTrees = await trees.concat(clusters).reduce(async (groupsPromise, cluster) => {
    const groups = await groupsPromise;
    const features = cluster.properties.cluster ? await getClusterFeatures(map, cluster.properties.cluster_id) : [cluster];
    features.forEach(({ properties: { common_name } }) => {
      if (!groups[common_name]) groups[common_name] = [];
      groups[common_name].push(cluster);
    });
    return groups;
  }, Promise.resolve({}));

  setVisibleTrees(Object.entries(groupedTrees).sort((a, b) => b[1].length - a[1].length));
};

const App = () => {
  const mapContainerRef = useRef(null);
  const mapRef = useRef(null);
  const popupRef = useRef(
    new mapboxgl.Popup({
      closeButton: true,
      closeOnClick: false,
      closeOnMove: true,
      offset: [0, -15],
      className: "text-medium",
    })
  );
  const mapboxButtonsRef = useRef(null);
  const longPressTimeoutRef = useRef(null);
  const [currentPopupLocation, setCurrentPopupLocation] = useState([]);
  const [treeLocations, setTreeLocations] = useState([]);
  const [treeInfo, setTreeInfo] = useState([]);
  const [visibleTrees, setVisibleTrees] = useState([]);
  const [highlightedTree, setHighlightedTree] = useState(null);
  const [isTreeListVisible, setIsTreeListVisible] = useState(false);
  const [isFormVisible, setIsFormVisible] = useState(false);
  const [newTreeCoordinates, setNewTreeCoordinates] = useState([]);
  const [mapLoaded, setMapLoaded] = useState(false);
  const [dataLoaded, setDataLoaded] = useState(false);
  const [layersLoaded, setLayersLoaded] = useState(false);

  const handleAddTreeCancel = () => {
    setNewTreeCoordinates([]);
    setIsFormVisible(false);
  }

  const handleAddTreeSubmit = async (newTree) => {
    try {
      const addedTree = await sendAddLocation({
        tree_id: newTree.tree_id,
        latin_name: newTree.latin_name,
        common_name: newTree.common_name,
        latitude: newTree.latitude,
        longitude: newTree.longitude,
        source: newTree.source,
        is_native: newTree.is_native,
      });
      setTreeLocations({
          ...treeLocations,
          features: [...treeLocations.features, treeToFeature(addedTree)]
      });
      setIsFormVisible(false);
    } catch (error) {
      console.error("Error adding new tree:", error);
    }
  };

  const highlightTree = async (treeName) => {
    if (mapRef.current && treeName) {
      const allClusters = mapRef.current.queryRenderedFeatures({ layers: ["clusters"] });
      const clusterIdsToHighlight = [];

      for (const cluster of allClusters) {
        const clusterId = cluster.properties.cluster_id;
        const leaves = await getClusterFeatures(mapRef.current, clusterId);
        if (leaves.some((leaf) => leaf.properties.common_name === treeName)) {
          clusterIdsToHighlight.push(clusterId);
        }
      }
      mapRef.current.setFilter("highlighted-point", ["in", "common_name", treeName]);
      mapRef.current.setFilter("highlighted-cluster", ["in", "cluster_id", ...clusterIdsToHighlight]);
    } else {
      mapRef.current.setFilter("highlighted-point", ["in", "common_name", ""]);
      mapRef.current.setFilter("highlighted-cluster", ["in", "cluster_id", ""]);
    }
  };

  const handleTreeListClick = (treeName) => {
    if (treeName === highlightedTree) {
      treeName = null
    }
    setHighlightedTree(treeName);
    highlightTree(treeName);
  };

  const fetchData = async () => {
    const locations = await fetchTreeLocations();
    const info = await fetchTreeInfo();
    setTreeLocations(locations);
    setTreeInfo(info);
    setDataLoaded(true)
  };

  useEffect(() => {
    const handleEscapeKey = (event) => {
      if (event.key === 'Escape') {
        popupRef.current.remove();
        handleAddTreeCancel();
      }
    };
    window.addEventListener('keydown', handleEscapeKey);

    const map = new mapboxgl.Map({
      container: mapContainerRef.current,
      style: "mapbox://styles/mapbox/streets-v11",
      center: [-71.09299151011383, 42.38245089323975],
      zoom: 18,
      boxZoom: false,
    });
    mapRef.current = map;

    map.on("load", () => {
      setMapLoaded(true);

      const geolocateControl = new mapboxgl.GeolocateControl({
        positionOptions: { enableHighAccuracy: true },
        trackUserLocation: true,
        showAccuracyCircle: false,
        showUserHeading: true,
      });
      map.addControl(geolocateControl, "top-right");

      document.querySelector(".mapboxgl-ctrl-top-right").appendChild(mapboxButtonsRef.current);

      map.on("mouseenter", "unclustered-point", () => { map.getCanvas().style.cursor = "pointer"} );
      map.on("mouseleave", "unclustered-point", () => { map.getCanvas().style.cursor = ""} );
      setTimeout(() => {  // for some reason, the geolocate control isn't fully added by this time
        geolocateControl.trigger();
      }, 1000);
    });
    return () => {
      map.remove();
    };
  }, []);

  useEffect(() => {
    fetchData();
  }, []);

  useEffect(() => {
    if (mapLoaded && dataLoaded && treeLocations) {
      addTreeLayers(mapRef.current, treeLocations);
      mapRef.current.once("idle", async () => {
        await updateVisibleTrees(mapRef.current, setVisibleTrees);
        setLayersLoaded(true)
      });
    }
  }, [mapLoaded, dataLoaded, treeLocations]);

  useEffect(() => {
    const handleLongPress = (event) => {
      setNewTreeCoordinates(event.lngLat);
      setIsFormVisible(true);
    };

    const startPress = (event) => {
      const features = mapRef.current.queryRenderedFeatures(event.point, {
        layers: ['unclustered-point', 'clusters'],
      });
      if (features.length === 0) {
        popupRef.current.remove();
        longPressTimeoutRef.current = setTimeout(() => handleLongPress(event), 1000);
      }
    };

    const endPress = () => {
      if (longPressTimeoutRef.current) {
        clearTimeout(longPressTimeoutRef.current);
        longPressTimeoutRef.current = null;
      }
    };

    if (mapLoaded && dataLoaded && layersLoaded) {
      mapRef.current.on("mousedown", startPress);
      mapRef.current.on("mouseup", endPress);
      mapRef.current.on("touchstart", startPress);
      mapRef.current.on("touchend", endPress);
      mapRef.current.on("touchcancel", endPress);
    }
    return () => {
      mapRef.current.off("mousedown", startPress);
      mapRef.current.off("mouseup", endPress);
      mapRef.current.off("touchstart", startPress);
      mapRef.current.off("touchend", endPress);
      mapRef.current.off("touchcancel", endPress);
    };
  }, [mapLoaded, dataLoaded, layersLoaded])

  useEffect(() => {
    if (mapLoaded && dataLoaded && layersLoaded) {
      mapRef.current.getSource("trees").setData(treeLocations);
    }
  }, [mapLoaded, dataLoaded, layersLoaded, treeLocations]);

  useEffect(() => {
    const removeTree = async (locationId) => {
      const removedBy = window.prompt("Please enter your name to confirm removal:");
      if (!removedBy) {
          alert("Removal canceled.");
          return;
      }
      await sendRemoveLocation(locationId, removedBy);
      const updatedFeatures = treeLocations.features.filter(
          feature => feature.properties.location_id !== locationId
      );
      setTreeLocations({
        ...treeLocations,
        features: updatedFeatures
      });
    };

    const createPopupContent = (tree, properties) => {
      return `
        <div class="p-0">
          <div class="font-sans text-sm leading-tight relative">
            <h3 class="m-0 text-lg font-bold">${properties.common_name}</h3>
            <p class="text-gray-500 italic text-sm">(${tree.family} ${properties.latin_name})</p>
            <div class="my-2 pb-2">
              <p>${properties.is_native === "True" ? "Native" : "Non-Native"}</p>
              <p>${tree.iucn_red_list_assessment}</p>
            </div>
          </div>
          <div class="absolute bottom-0 right-0 mb-2 mr-2 text-xs italic text-gray-400">
            ${properties.source}
          </div>
        </div>
      `;
    }

    const handlePopupButtonClose = (event, locationId) => {
      event.stopPropagation();
      event.preventDefault();
      removeTree(locationId);
    }

    const createTreePopup = (event) => {
      if (event.features && treeInfo) {
        const coordinates = event.features[0].geometry.coordinates.slice();
        const locationProperties = event.features[0].properties;
        const tree = treeInfo[locationProperties.tree_id]
        const popupContent = createPopupContent(tree, locationProperties);
        setCurrentPopupLocation(locationProperties.location_id);
        popupRef.current
          .setLngLat(coordinates)
          .setHTML(popupContent)
          .addTo(mapRef.current);

        const closeButton = popupRef.current._closeButton;
        if (closeButton) {
          closeButton.addEventListener('click', (event) => handlePopupButtonClose(event, locationProperties.location_id));
        }
        closeButton.className = "absolute top-0 right-0 mt-2 mr-2 text-gray-500 hover:text-gray-800 focus:outline-none bg-white rounded-full shadow-md w-6 h-6 flex items-center justify-center"
      }
      return () => {
        const closeButton = popupRef.current._closeButton;
        if (closeButton) {
          closeButton.removeEventListener('click', handlePopupButtonClose);
        }
      }
    };

    if (mapLoaded && layersLoaded && treeInfo) {
      mapRef.current.on("mousedown", "unclustered-point", createTreePopup);
      mapRef.current.on("touchstart", "unclustered-point", createTreePopup);
    }

    return () => {
      mapRef.current.off("mousedown", "unclustered-point", createTreePopup);
      mapRef.current.off("touchstart", "unclustered-point", createTreePopup);
    }
  }, [mapLoaded, layersLoaded, treeInfo, currentPopupLocation, treeLocations]);

  useEffect(() => {
    const updateMap = async (treeName) => {
      await highlightTree(treeName);
      await updateVisibleTrees(mapRef.current, setVisibleTrees);
    };
    const debouncedUpdateMap = debounce(() => updateMap(highlightedTree), 300);
    if (mapLoaded) {
      mapRef.current.on("moveend", debouncedUpdateMap);
      mapRef.current.on("zoomend", debouncedUpdateMap);
    }
    return () => {
      if (mapRef.current) {
        mapRef.current.off("moveend", debouncedUpdateMap);
        mapRef.current.off("zoomend", debouncedUpdateMap);
      }
    };
  }, [highlightedTree, mapLoaded]);

  return (
    <div>
      <div ref={mapContainerRef} className="w-screen h-screen" />
      <div>
        {isFormVisible && (
          <div>
            <div className="absolute top-0 left-0 w-full h-full bg-black opacity-50 pointer-events-none" />
            <div className="absolute top-0 left-0 w-full h-full z-50">
              <NewTreeForm treeList={treeInfo} coordinates={newTreeCoordinates} onSubmit={handleAddTreeSubmit} onCancel={handleAddTreeCancel} />
            </div>
          </div>
        )}
      </div>
      <div className={`absolute top-0 left-0 bg-white p-4 shadow-lg max-h-screen overflow-y-auto z-40 transition-transform transform duration-500 ${isTreeListVisible ? "translate-x-0": "-translate-x-[120%]" }`}>
        <h3 className="text-lg font-bold mb-2">Visible Trees</h3>
        <ul>
          {visibleTrees.map(([name, trees], index) => (
            <li
              key={index}
              className={`text-sm text-gray-700 cursor-pointer hover:bg-blue-200 ${highlightedTree === name ? "bg-orange-300" : ""}`}
              onClick={() => handleTreeListClick(name)}
            >
              <strong>{name}</strong> ({trees.length} trees)
            </li>
          ))}
        </ul>
      </div>

      {/* Hidden buttons to be added to the map control later */}
      <div
        ref={mapboxButtonsRef}
        className={`mapboxgl-ctrl mapboxgl-ctrl-group`}
        onClick={() => setIsTreeListVisible(!isTreeListVisible)}
      >
        <button className="relative z-30">
          <div className="relative flex overflow-hidden items-center justify-center">
            <div className="flex flex-col justify-between w-[1rem] h-[1rem] origin-center overflow-hidden">
              <div className={`${isTreeListVisible ? "bg-[rgb(45,166,222)]" : "bg-gray-800"} h-[3px] origin-left rounded`} aria-hidden="true"/>
              <div className={`${isTreeListVisible ? "bg-[rgb(45,166,222)]" : "bg-gray-800"} h-[3px] origin-left rounded`} aria-hidden="true"/>
              <div className={`${isTreeListVisible ? "bg-[rgb(45,166,222)]" : "bg-gray-800"} h-[3px] origin-left rounded`} aria-hidden="true"/>
            </div>
          </div>
        </button>
      </div>
    </div>
  );
};

export default App;
